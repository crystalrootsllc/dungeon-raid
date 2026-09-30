"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import type { GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { createFriendReader, spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const BOSS = "Shade Moth";
const PLAYER_HP = 100;
const SHIELD_HP = 100;
const BEAM_NEED = 2; // timed guards needed to unlock Rare Beam
const ATTACK_DMG = 7;
const BEAM_MULT = 5; // Rare Beam on OPEN = 5x Attack
const ATTACK_CD = 0.33;
const GUARD_WHIFF_CD = 0.5;
const LATE_WINDOW = 0.45; // seconds after an impact where Guard reads "Too late"

type Difficulty = "normal" | "max";
type Screen = "title" | "play" | "victory" | "defeat" | "board";
type Menu = "settings" | "help" | "quit" | null;
type Cadence = "open" | "incoming";
type GuardState = "none" | "early" | "timed";
type Facing = "right" | "left" | "down" | "up";

/** barHp sized so a perfect Normal run is about 20s and a perfect Max run about 35s. */
const DIFF: Record<Difficulty, { label: string; bars: number; barHp: number; mult: number; blurb: string }> = {
  normal: { label: "Normal", bars: 2, barHp: 165, mult: 1, blurb: "2 boss bars" },
  max: { label: "Max", bars: 4, barHp: 165, mult: 2.5, blurb: "4 bars, faster, double strikes" },
};

function tune(diff: Difficulty, broken: number) {
  if (diff === "normal") {
    return {
      open: Math.max(1.6, 2.0 - broken * 0.2), wind: Math.max(1.15, 1.35 - broken * 0.12), perfect: 0.4,
      hit: 20, early: 10, counter: 6, double: 0,
    };
  }
  return {
    open: Math.max(1.05, 1.45 - broken * 0.12), wind: Math.max(0.82, 1.0 - broken * 0.06), perfect: 0.32,
    hit: 26, early: 13, counter: 9, double: broken >= 1 ? 0.35 : 0,
  };
}

type Popup = { x: number; y: number; text: string; color: string; life: number; scale: "sm" | "md" | "lg" };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
type Fight = {
  diff: Difficulty; bars: number; barHp: number; foeHp: number; foeMax: number;
  playerHp: number; shield: number; shieldMax: number; usedShield: boolean;
  cadence: Cadence; timer: number; wind: number; doublePending: boolean;
  guard: GuardState; guardCd: number; attackCd: number; lastImpact: number;
  beam: number; timed: number; early: number; late: number; damageTaken: number;
  elapsed: number; live: boolean;
  feedback: string; feedbackKind: string; feedbackT: number;
  shake: number; playerFlash: number; foeFlash: number; strikeFx: number; strikeBlocked: boolean;
  wing: number; particles: Particle[]; popups: Popup[];
  hitStop: number; breakFx: number; beamFx: number; breaks: number; clock: number;
};

const brokenBars = (f: Fight) => f.bars - Math.ceil(Math.max(0, f.foeHp) / f.barHp);

function makeFight(diff: Difficulty, shield: boolean): Fight {
  const { bars, barHp } = DIFF[diff];
  const t = tune(diff, 0);
  return {
    diff, bars, barHp, foeHp: bars * barHp, foeMax: bars * barHp,
    playerHp: PLAYER_HP, shield: shield ? SHIELD_HP : 0, shieldMax: shield ? SHIELD_HP : 0, usedShield: shield,
    cadence: "open", timer: t.open + 0.6, wind: t.wind, doublePending: false,
    guard: "none", guardCd: 0, attackCd: 0, lastImpact: -10,
    beam: 0, timed: 0, early: 0, late: 0, damageTaken: 0,
    elapsed: 0, live: true,
    feedback: "OPEN: Attack now", feedbackKind: "info", feedbackT: 1.6,
    shake: 0, playerFlash: 0, foeFlash: 0, strikeFx: 0, strikeBlocked: false,
    wing: 0, particles: [], popups: [],
    hitStop: 0, breakFx: 0, beamFx: 0, breaks: 0, clock: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Score + local leaderboard                                           */
/* ------------------------------------------------------------------ */

type Score = { base: number; time: number; damage: number; guards: number; mult: number; total: number };
function scoreRun(diff: Difficulty, clearMs: number, damageTaken: number, timed: number): Score {
  const base = 5000;
  const time = Math.max(0, Math.round(6000 - clearMs / 10)); // full bonus at 0s, gone at 60s
  const damage = -Math.round(damageTaken * 15);
  const guards = timed * 250;
  const mult = DIFF[diff].mult;
  const total = Math.max(0, Math.round((base + time + damage + guards) * mult));
  return { base, time, damage, guards, mult, total };
}

type Entry = { friendId: string; diff: Difficulty; score: number; clearMs: number; damage: number; timed: number; shield: boolean; at: number };
const LB_KEY = "rf-dungeon-raid-leaderboard-v1";
const LB_LIMIT = 25;

function validEntry(e: unknown): e is Entry {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  return typeof v.friendId === "string" && /^[0-9]{1,12}$/.test(v.friendId) && (v.diff === "normal" || v.diff === "max")
    && [v.score, v.clearMs, v.damage, v.timed, v.at].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
    && typeof v.shield === "boolean";
}

/** localStorage when the document allows it; the FriendSDK sandbox usually blocks it, so fall back to memory. */
const board = (() => {
  let persistent = false;
  let entries: Entry[] = [];
  try {
    const ls = window.localStorage;
    const raw = ls.getItem(LB_KEY);
    ls.setItem(`${LB_KEY}:probe`, "1");
    ls.removeItem(`${LB_KEY}:probe`);
    persistent = true;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) entries = parsed.filter(validEntry);
  } catch {
    persistent = false;
  }
  const save = () => {
    if (!persistent) return;
    try { window.localStorage.setItem(LB_KEY, JSON.stringify(entries)); } catch { persistent = false; }
  };
  return {
    get persistent() { return persistent; },
    list(diff: Difficulty) { return entries.filter(e => e.diff === diff).sort((a, b) => b.score - a.score || a.clearMs - b.clearMs); },
    add(entry: Entry) {
      entries.push(entry);
      const keep: Entry[] = [];
      for (const d of ["normal", "max"] as const) keep.push(...entries.filter(e => e.diff === d).sort((a, b) => b.score - a.score || a.clearMs - b.clearMs).slice(0, LB_LIMIT));
      entries = keep;
      save();
      const list = this.list(entry.diff);
      const rank = list.indexOf(entry);
      return rank < 0 ? null : rank + 1;
    },
  };
})();

/* ------------------------------------------------------------------ */
/* Art                                                                 */
/* ------------------------------------------------------------------ */

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const rf = (v: bigint) => `${formatGameAmount(v, 18)} RF`;

/* ------------------------------------------------------------------ */
/* Shade Moth pixel art: 48x32 grid, left half mirrored. Chunky cells   */
/* drawn nearest-neighbor with an ink outline, RF palette only.         */
/* # ink  L lilac  D dusk lilac  S sun  C coral  P paper  N body         */
/* E eyes/ocelli (lime idle, coral wind-up)  K weak core (lime on OPEN)  */
/* ------------------------------------------------------------------ */

const MOTH_IDLE: readonly string[] = [
  "..............##........",
  ".............#PP#.......",
  "..............#PP#......",
  "...............#PP#.....",
  "................#PP#....",
  ".................#P#....",
  "..................######",
  ".................#NNNNNN",
  ".................#NEENNN",
  ".................#NEENNN",
  "..........#####..#NNNNNN",
  "........##LLLLL##PPPPPPP",
  "......##LLLLLLLL#PPPPPPP",
  ".....#LLLDDDDLLLL#NNNNNN",
  "....#LLLDDDDDDLLL#NNNNNN",
  "...#LLLDDSSSSDDLL#NNNKKK",
  "..#LLLDDSS##SSDLL#NNKKKK",
  "..#LLLDDS#EE#SDLL#NNKKKK",
  ".#LLLLDDS#EE#SDLL#NNKKKK",
  ".#LLLLDDSS##SSDLL#NNNKKK",
  ".#LLLLLDDSSSSDDLL#NNNNNN",
  "..#LLLLLDDDDDDLLL#N#NNNN",
  "...#LLLLLLLLLLLL#.#NNNNN",
  "....##LLLLLLLL##..#NNNNN",
  "......#DDDDDD#....#N#NNN",
  ".....#DDDDDDDD#...#NNNNN",
  "....#DDDCCCCDDD#..#NNNNN",
  "....#DDCC##CCDD#...#N#NN",
  ".....#DDCCCCDD#....#NNNN",
  "......##DDDD##......#NNN",
  "........####.........##N",
  "......................##",
];
const MOTH_FLAP: readonly string[] = [
  "..............##........",
  ".............#PP#.......",
  "..............#PP#......",
  "...............#PP#.....",
  "................#PP#....",
  ".................#P#....",
  "..................######",
  ".................#NNNNNN",
  ".................#NEENNN",
  ".................#NEENNN",
  "...........#####.#NNNNNN",
  ".........##LLLLL#PPPPPPP",
  ".......##LLLLLLLLPPPPPPP",
  "......#LLLDDDDLLL#NNNNNN",
  ".....#LLLDDDDDDLL#NNNNNN",
  "....#LLLDDSSSSDDL#NNNKKK",
  "...#LLLDDSS##SSDL#NNKKKK",
  "...#LLLDDS#EE#SDL#NNKKKK",
  "..#LLLLDDS#EE#SDL#NNKKKK",
  "..#LLLLDDSS##SSDL#NNNKKK",
  "..#LLLLLDDSSSSDDL#NNNNNN",
  "...#LLLLLDDDDDDLL#N#NNNN",
  "....#LLLLLLLLLLLL.#NNNNN",
  ".....##LLLLLLLL##.#NNNNN",
  ".......#DDDDDD#...#N#NNN",
  "......#DDDDDDDD#..#NNNNN",
  ".....#DDDCCCCDDD#.#NNNNN",
  ".....#DDCC##CCDD#..#N#NN",
  "......#DDCCCCDD#...#NNNN",
  ".......##DDDD##.....#NNN",
  ".........####........##N",
  "......................##",
];
const MOTH_WIND: readonly string[] = [
  "..............##........",
  ".............#PP#.......",
  "..............#PP#......",
  "...............#PP#.....",
  "................#PP#....",
  ".................#P#....",
  "..................######",
  "..........#####..#NNNNNN",
  "........##LLLLL###NEENNN",
  "......##LLLLLLLL##NEENNN",
  ".....#LLLDDDDLLLL#NNNNNN",
  "....#LLLDDDDDDLLLPPPPPPP",
  "...#LLLDDSSSSDDLLPPPPPPP",
  "..#LLLDDSS##SSDLL#NNNNNN",
  "..#LLLDDS#EE#SDLL#NNNNNN",
  ".#LLLLDDS#EE#SDLL#NNNKKK",
  ".#LLLLDDSS##SSDLL#NNKKKK",
  ".#LLLLLDDSSSSDDLL#NNKKKK",
  "..#LLLLLDDDDDDLLL#NNKKKK",
  "...#LLLLLLLLLLLL##NNNKKK",
  "....##LLLLLLLL##.#NNNNNN",
  "......#DDDDDD#...#N#NNNN",
  ".....#DDDDDDDD#...#NNNNN",
  "....#DDDCCCCDDD#..#NNNNN",
  "....#DDCC##CCDD#..#N#NNN",
  ".....#DDCCCCDD#...#NNNNN",
  "......##DDDD##....#NNNNN",
  "........####.......#N#NN",
  "...................#NNNN",
  "....................#NNN",
  ".....................##N",
  "......................##",
];
const MOTH_DEFEAT: readonly string[] = [
  "..............##........",
  ".............#PP#.......",
  "...............###......",
  "..............#PPP#.....",
  "...............#PPP#....",
  "................##P#....",
  "..................######",
  ".................#NNNNNN",
  ".................#NEENNN",
  ".................#NEENNN",
  ".................#NNNNNN",
  ".................PPPPPPP",
  "...........#####.PPPPPPP",
  ".........##LLLLL##NNNNNN",
  ".......##LLLLLLLL#NNNNNN",
  "......#LLLDDDDLLL#NNNKKK",
  ".....#LLLDDDDDDLL#NNKKKK",
  "....#LLLDDSSSSDDL#NNKKKK",
  "...#LLLDDSS##SSDL#NNKKKK",
  "...#LLLDDS#EE#SDL#NNNKKK",
  "..#LLLLDDS#EE#SDL#NNNNNN",
  "..#LLLLDDSS##SSDL#N#NNNN",
  "..#LLLLLDDSSSSDDL.#NNNNN",
  "...#LLLLLDDDDDDLL.#NNNNN",
  "....#LLLLLLLLLLLL.#N#NNN",
  ".....##LLLLLLLL##.#NNNNN",
  ".......#DDDDDD#...#NNNNN",
  "......#DDDDDDDD#...#N#NN",
  ".....#DDDCCCCDDD#..#NNNN",
  ".....#DDCC##CCDD#...#NNN",
  "......#DDCCCCDD#.....##N",
  ".......##DDDD##.......##",
];

const MOTH_W = 48, MOTH_H = 32;
const MOTH_INK: Record<string, string> = {
  "#": "#111111", L: "#B3A0D8", D: "#7A68A8", S: "#F2CE68", C: "#ED927E", G: "#CCFF00", P: "#EEEEEE", W: "#FFFFFF", N: "#241E33",
};
type MothState = "idle" | "open" | "wind" | "defeat" | "flash";
type MothFrame = "idle" | "flap" | "wind" | "defeat";
const MOTH_FRAMES: Record<MothFrame, readonly string[]> = {
  idle: MOTH_IDLE.map(r => r + [...r].reverse().join("")),
  flap: MOTH_FLAP.map(r => r + [...r].reverse().join("")),
  wind: MOTH_WIND.map(r => r + [...r].reverse().join("")),
  defeat: MOTH_DEFEAT.map(r => r + [...r].reverse().join("")),
};
function mothCell(ch: string, state: MothState): string | null {
  if (ch === ".") return null;
  if (state === "flash") return ch === "#" ? "#" : "W";
  if (ch === "E") return state === "wind" ? "C" : state === "defeat" ? "#" : "G";
  if (ch === "K") return state === "open" ? "G" : "N";
  if (state === "wind" && ch === "L") return "D";
  if (state === "defeat") return ch === "L" ? "D" : ch === "D" ? "N" : ch;
  return ch;
}
const mothCache = new Map<string, HTMLCanvasElement>();
/** 1 canvas pixel per art cell; scaled up later with smoothing off. */
function mothBitmap(frame: MothFrame, state: MothState): HTMLCanvasElement {
  const key = `${frame}:${state}`;
  const hit = mothCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = MOTH_W; c.height = MOTH_H;
  const g = c.getContext("2d")!;
  MOTH_FRAMES[frame].forEach((row, y) => [...row].forEach((ch, x) => {
    const k = mothCell(ch, state);
    if (!k) return;
    g.fillStyle = MOTH_INK[k]!;
    g.fillRect(x, y, 1, 1);
  }));
  mothCache.set(key, c);
  return c;
}
/** Snap a CSS length to whole device pixels so every art cell is the same size. */
function cellSize(targetWidth: number) {
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  return Math.max(2, Math.floor((targetWidth / MOTH_W) * dpr)) / dpr;
}
/** Pixel squares along a circle / arc, each snapped to the cell grid. */
function pixelArc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, cell: number, a0 = 0, a1 = Math.PI * 2, dashed = false) {
  const n = Math.max(12, Math.round(((a1 - a0) * r) / (cell * 1.15)));
  for (let i = 0; i <= n; i++) {
    if (dashed && i % 2) continue;
    const a = a0 + ((a1 - a0) * i) / n;
    const x = Math.round((cx + Math.cos(a) * r) / cell) * cell, y = Math.round((cy + Math.sin(a) * r) / cell) * cell;
    ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
  }
}
function pixelLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, cell: number) {
  const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / cell));
  for (let i = 0; i <= n; i++) {
    const x = Math.round((x0 + ((x1 - x0) * i) / n) / cell) * cell, y = Math.round((y0 + ((y1 - y0) * i) / n) / cell) * cell;
    ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
  }
}
/** Thick pixel beam (width in cells) from (x0,y0) to (x1,y1). */
function pixelBeam(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, cell: number, widthCells: number) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const px = -dy / len * cell, py = dx / len * cell;
  const half = (widthCells - 1) / 2;
  for (let w = -half; w <= half; w++) {
    const ox = px * w, oy = py * w;
    pixelLine(ctx, x0 + ox, y0 + oy, x1 + ox, y1 + oy, cell);
  }
}

/* ------------------------------------------------------------------ */
/* 5x7 pixel font (damage numbers, banners, wordmark). No emoji.        */
/* ------------------------------------------------------------------ */

const FONT: Record<string, readonly string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  "-": [".....", ".....", ".....", ".###.", ".....", ".....", "....."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  ".": [".....", ".....", ".....", ".....", ".....", ".....", "..#.."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};
const glyph = (ch: string) => FONT[ch] ?? FONT[ch.toUpperCase()] ?? FONT[" "]!;
const textCells = (text: string) => Math.max(0, text.length * 6 - 1);
/**
 * Draw pixel text with a 1-cell ink outline. `fill` may vary by glyph row for two-tone lettering.
 * x is the anchor (left / center / right), y the top edge. Every square snaps to the cell grid.
 */
function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, cell: number,
  fill: string | ((row: number) => string), o: { align?: "left" | "center" | "right"; shadow?: string | null } = {}) {
  const width = textCells(text) * cell;
  const left = Math.round((o.align === "left" ? x : o.align === "right" ? x - width : x - width / 2) / cell) * cell;
  const top = Math.round(y / cell) * cell;
  const px: Array<readonly [number, number, number]> = [];
  [...text].forEach((ch, i) => glyph(ch).forEach((row, r) => [...row].forEach((c, cx) => {
    if (c === "#") px.push([left + (i * 6 + cx) * cell, top + r * cell, r]);
  })));
  // paper halo then ink ring — thinner halo for small combat text
  const pad = cell <= 2 ? 1 : 2;
  ctx.fillStyle = "#EEEEEE";
  for (const [px0, py0] of px) ctx.fillRect(px0 - cell * pad, py0 - cell * pad, cell * (1 + pad * 2), cell * (1 + pad * 2));
  if (o.shadow) { ctx.fillStyle = o.shadow; for (const [px0, py0] of px) ctx.fillRect(px0 - cell, py0, cell * 3, cell * 3); }
  ctx.fillStyle = "#111111";
  for (const [px0, py0] of px) ctx.fillRect(px0 - cell, py0 - cell, cell * 3, cell * 3);
  for (const [px0, py0, r] of px) { ctx.fillStyle = typeof fill === "string" ? fill : fill(r); ctx.fillRect(px0, py0, cell, cell); }
}

/* ------------------------------------------------------------------ */
/* Dungeon backdrop: stone brick wall, dark arch, torches with a 2-frame */
/* pixel flicker, flagstone floor. Rendered once per layout at 1 canvas  */
/* pixel per art cell, then scaled with smoothing off.                   */
/* Palette: ink, muted stone grays, sun torch light, coral flame base.   */
/* ------------------------------------------------------------------ */

const DG = {
  ink: "#111111", mortar: "#1b1b1f", lo: "#27272c", s1: "#313137", s2: "#3a3a41", s3: "#44444b", hi: "#55555d",
  ledge: "#6b6b73", floorA: "#1c1c20", floorB: "#222227", floorLine: "#121215", sun: "#F2CE68", coral: "#ED927E", paper: "#EEEEEE",
};
const FLAME: readonly (readonly string[])[] = [
  ["..S..", ".SS..", ".SPS.", "SSPSS", "SPPPS", "SCPCS", ".CCC."],
  [".....", ".S.S.", ".SSS.", "SSPSS", "SPPPS", "SCPCS", ".CCC."],
];
const SCONCE: readonly string[] = ["#HHH#", ".#H#.", "..#..", "..#..", ".###."];
const hash2 = (a: number, b: number) => {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const mixCache = new Map<string, string>();
function mix(a: string, b: string, t: number) {
  const key = `${a}${b}${t}`;
  const hit = mixCache.get(key);
  if (hit) return hit;
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const out = "#" + pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, "0")).join("");
  mixCache.set(key, out);
  return out;
}
type Torch = { x: number; y: number }; // CSS px: flame top-center
type DungeonSpec = { w: number; h: number; cell: number; floorY: number; archX: number | null; archW: number; archTop: number; torches: Torch[] };
const DUNGEON_MARGIN = 3; // art cells of overscan so screen shake never shows an edge
const dungeonCache = new Map<string, HTMLCanvasElement[]>();
function dungeonFrames(spec: DungeonSpec): HTMLCanvasElement[] {
  const { cell } = spec;
  const key = JSON.stringify(spec);
  const hit = dungeonCache.get(key);
  if (hit) return hit;
  if (dungeonCache.size > 6) dungeonCache.clear();
  const m = DUNGEON_MARGIN;
  const gw = Math.ceil(spec.w / cell) + m * 2, gh = Math.ceil(spec.h / cell) + m * 2;
  const floor = Math.round(spec.floorY / cell) + m;
  const ax = spec.archX === null ? -999 : Math.round(spec.archX / cell) + m;
  const ahw = Math.max(4, Math.round(spec.archW / cell / 2)); // half width
  const aTop = Math.round(spec.archTop / cell) + m + ahw; // top of the straight jambs (arch crown is ahw above)
  const torches = spec.torches.map(t => ({ x: Math.round(t.x / cell) + m, y: Math.round(t.y / cell) + m }));
  const frames = [0, 1].map(frame => {
    const c = document.createElement("canvas");
    c.width = gw; c.height = gh;
    const g = c.getContext("2d")!;
    const put = (x: number, y: number, color: string) => { g.fillStyle = color; g.fillRect(x, y, 1, 1); };
    const glowR = frame === 0 ? [3.5, 6.5, 9.5] : [3, 5.5, 8.5];
    const glowT = [0.36, 0.2, 0.09];
    const glow = (x: number, y: number) => {
      let best = 0;
      for (const t of torches) {
        const d = Math.hypot(x - t.x, (y - (t.y + 3)) * 1.1) + ((x + y) & 1) * 0.6; // checker dither on band edges
        for (let b = 0; b < 3; b++) if (d < glowR[b]!) { best = Math.max(best, glowT[b]!); break; }
      }
      return best;
    };
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let color: string;
      const inArchX = Math.abs(x - ax + 0.5) < ahw;
      const crown = y < aTop ? Math.hypot(x - ax + 0.5, y - aTop) < ahw : true;
      if (y < floor && inArchX && crown && y >= aTop - ahw) {
        // dark archway; a lighter stone frame of alternating voussoirs
        const edge = Math.abs(x - ax + 0.5) >= ahw - 1 || (y < aTop && Math.hypot(x - ax + 0.5, y - aTop) >= ahw - 1);
        color = edge ? ((Math.floor((x + y) / 2) & 1) ? DG.ledge : DG.hi) : (y > floor - 3 ? "#16161a" : DG.ink);
      } else if (y < floor) {
        const row = Math.floor(y / 4), bx = x + (row & 1) * 4, col = Math.floor(bx / 8);
        const r = hash2(row, col);
        if (y % 4 === 3 || bx % 8 === 7) color = DG.mortar;
        else {
          const base = r < 0.33 ? DG.s1 : r < 0.72 ? DG.s2 : DG.s3;
          color = y % 4 === 0 && bx % 8 < 6 ? mix(base, DG.hi, 0.5) : y % 4 === 2 ? mix(base, DG.lo, 0.5) : base;
          if (hash2(x * 7 + 3, y * 13 + 1) < 0.035) color = DG.lo; // chips and cracks
        }
        if (y < m + 2) color = mix(color, DG.ink, 0.45); // ceiling shadow
        const lit = glow(x, y);
        if (lit && color !== DG.mortar) color = mix(color, DG.sun, lit);
        else if (lit) color = mix(color, DG.sun, lit * 0.5);
      } else if (y === floor) color = DG.ledge;
      else if (y === floor + 1) color = DG.lo;
      else {
        // flagstones: rows get taller toward the viewer
        let top = floor + 2, hgt = 2, row = 0;
        while (top + hgt <= y) { top += hgt; hgt = Math.min(6, hgt + 1); row++; }
        const tw = 8 + row * 2, tx = x + (row & 1) * Math.floor(tw / 2);
        if (y === top + hgt - 1 || tx % tw === tw - 1) color = DG.floorLine;
        else color = hash2(row, Math.floor(tx / tw)) < 0.5 ? DG.floorA : DG.floorB;
        const lit = glow(x, floor - 1) * 0.35;
        if (lit && Math.abs(y - floor) < 6) color = mix(color, DG.sun, lit);
      }
      put(x, y, color);
    }
    // torches: sconce + flame (frame decides the flame shape)
    for (const t of torches) {
      SCONCE.forEach((row, r) => [...row].forEach((ch, i) => {
        if (ch === ".") return;
        put(t.x - 2 + i, t.y + 7 + r, ch === "#" ? DG.ink : DG.hi);
      }));
      FLAME[frame]!.forEach((row, r) => [...row].forEach((ch, i) => {
        if (ch === ".") return;
        put(t.x - 2 + i, t.y + r, ch === "S" ? DG.sun : ch === "P" ? DG.paper : DG.coral);
      }));
    }
    return c;
  });
  dungeonCache.set(key, frames);
  return frames;
}
function drawDungeon(ctx: CanvasRenderingContext2D, spec: DungeonSpec, flicker: number) {
  const frames = dungeonFrames(spec);
  const img = frames[flicker & 1]!;
  const m = DUNGEON_MARGIN * spec.cell;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, -m, -m, img.width * spec.cell, img.height * spec.cell);
}

/**
 * Shade Moth, chunky pixel art. `s` keeps the old layout contract: the moth spans about 116*s CSS px.
 * States: idle (slow flap), OPEN (lime weak core, blinking pixel halo), INCOMING (wings raised,
 * coral eyes, jitter), hit flash (white fill, ink outline kept), defeat (drooped, eyes out).
 */
function drawBoss(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, wing: number, o: { flash: number; reduced: boolean; mode: Cadence | "idle" | "defeat"; openPulse: number }) {
  const cell = cellSize(116 * s);
  const w = MOTH_W * cell, h = MOTH_H * cell;
  const flapOn = !o.reduced && Math.sin(wing) > 0.35;
  let frame: MothFrame = flapOn ? "flap" : "idle";
  let state: MothState = o.mode === "open" ? "open" : "idle";
  let dx = 0, dy = 0;
  if (o.mode === "incoming") { frame = "wind"; state = "wind"; if (!o.reduced && Math.floor(wing * 3) % 2) dx = cell; }
  if (o.mode === "defeat") { frame = "defeat"; state = "defeat"; dy = cell * 2; }
  if (o.flash > 0 && o.mode !== "defeat") state = "flash";
  if (!o.reduced && o.mode !== "defeat" && o.mode !== "incoming") dy = Math.round(Math.sin(wing * 0.5) * 1) * cell;
  const left = Math.round((x - w / 2 + dx) / cell) * cell, top = Math.round((y - h / 2 + dy) / cell) * cell;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  // OPEN: blinking lime pixel halo around the weak core
  if (o.mode === "open" && (o.reduced || Math.floor(o.openPulse * 4) % 2 === 0)) {
    ctx.fillStyle = "#CCFF00";
    const cx = left + 24 * cell, cy = top + 17.5 * cell;
    pixelArc(ctx, cx, cy, 6.5 * cell, cell, 0, Math.PI * 2, true);
  }
  // INCOMING: coral pixel sparks flicking off the wing tips
  if (o.mode === "incoming") {
    ctx.fillStyle = "#ED927E";
    const k = o.reduced ? 0 : Math.floor(wing * 2) % 3;
    for (const side of [-1, 1]) {
      ctx.fillRect(left + (side < 0 ? 0 : w - cell) + side * (2 + k) * cell, top + (4 + k) * cell, cell, cell);
      ctx.fillRect(left + (side < 0 ? 0 : w - cell) + side * (1 + k) * cell, top + (9 - k) * cell, cell, cell);
    }
  }
  ctx.drawImage(mothBitmap(frame, state), left, top, w, h);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath(); ctx.rect(x, y, w, h);
}

/** Title art: dungeon backdrop, DUNGEON RAID wordmark, large idle Shade Moth. */
function TitleScene({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = ref.current;
    const ctx = node?.getContext("2d");
    if (!node || !ctx) return;
    let raf = 0, wing = 0, last = performance.now(), clock = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!reduced) { wing += dt * 3.4; clock += dt; }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = node.clientWidth || 300, h = node.clientHeight || 200;
      if (node.width !== Math.round(w * dpr) || node.height !== Math.round(h * dpr)) { node.width = Math.round(w * dpr); node.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // wordmark: one line when it fits at >= 4px cells, otherwise two lines
      const oneLine = Math.floor((w - 28) / textCells("DUNGEON RAID"));
      const two = oneLine < 4;
      const wc = Math.max(3, Math.min(8, two ? Math.floor((w - 28) / textCells("DUNGEON")) : oneLine));
      const wordH = (two ? 16 : 7) * wc + wc * 2;
      const top = 12;
      const floorY = h - Math.max(18, Math.min(40, h * 0.14));
      const avail = floorY - (top + wordH + 10);
      const s = Math.max(0.6, Math.min((w * 0.8) / 116, (avail * 0.98) / 77.3));
      const cell = cellSize(116 * s);
      const mothH = 77.3 * s;
      const by = Math.min(floorY - mothH / 2 + cell, top + wordH + 10 + avail / 2 + cell);
      const tY = Math.max(top + wordH + 6, by - mothH / 2);
      drawDungeon(ctx, { w: Math.ceil(w), h: Math.ceil(h), cell, floorY, archX: w / 2, archW: w * 0.44, archTop: tY + cell * 2,
        torches: [{ x: cell * 4, y: tY }, { x: w - cell * 4, y: tY }] }, reduced ? 0 : Math.floor(clock / 0.17));
      const band = (r: number) => (r < 5 ? DG.sun : DG.coral);
      if (two) {
        drawPixelText(ctx, "DUNGEON", w / 2, top, wc, band, { shadow: DG.ink });
        drawPixelText(ctx, "RAID", w / 2, top + 9 * wc, wc, band, { shadow: DG.ink });
      } else drawPixelText(ctx, "DUNGEON RAID", w / 2, top, wc, band, { shadow: DG.ink });
      drawBoss(ctx, w / 2, by, s, wing, { flash: 0, reduced, mode: "idle", openPulse: 0 });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  return <canvas ref={ref} className="nr-title-scene" aria-label="Dungeon Raid: Shade Moth waits in the dungeon" role="img" />;
}

function FriendCanvas({ friendId, reduced, facing = "right", size = 96, className = "nr-friend-canvas", canvasRef: ext, active = true }: {
  friendId: bigint; reduced: boolean; facing?: Facing; size?: number; className?: string;
  canvasRef?: MutableRefObject<HTMLCanvasElement | null>; active?: boolean;
}) {
  const local = useRef<HTMLCanvasElement>(null);
  const canvasRef = ext ?? local;
  const spritesRef = useRef<GenerationSprites | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    let alive = true;
    spritesRef.current = null;
    void createFriendReader().read(friendId).then(s => { if (alive) spritesRef.current = s; }).catch(() => {});
    return () => { alive = false; };
  }, [friendId]);
  useEffect(() => {
    const node = canvasRef.current;
    const ctx = node?.getContext("2d");
    if (!node || !ctx) return;
    let raf = 0;
    const grid = 16, scale = Math.max(2, Math.floor(size / 16));
    const draw = (now: number) => {
      ctx.clearRect(0, 0, node.width, node.height);
      const sprites = spritesRef.current;
      if (sprites) {
        const walking = activeRef.current && !reduced;
        const tick = reduced ? 0 : Math.floor(now / 110) % 8;
        const rows = spriteFrame(sprites, facing, walking, tick, "right").frame.rows;
        const left = Math.round((node.width - grid * scale) / 2), top = Math.round((node.height - grid * scale) / 2);
        ctx.imageSmoothingEnabled = false;
        const px: Array<readonly [number, number]> = [];
        rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") px.push([x, y]); }));
        ctx.fillStyle = "#eeeeee";
        for (const [x, y] of px) ctx.fillRect(left + x * scale - 2, top + y * scale - 2, scale + 4, scale + 4);
        ctx.fillStyle = "#111111";
        for (const [x, y] of px) ctx.fillRect(left + x * scale, top + y * scale, scale, scale);
      } else {
        ctx.fillStyle = "#111111"; ctx.fillRect(size * 0.3, size * 0.2, size * 0.4, size * 0.6);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [friendId, reduced, size, facing, canvasRef]);
  return <canvas ref={canvasRef} width={size} height={size} className={className} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Music                                                               */
/* ------------------------------------------------------------------ */

function createMusic() {
  let ctx: AudioContext | null = null, master: GainNode | null = null, timer: number | null = null;
  let step = 0, muted = false;
  const bass = [55, 55, 65.41, 73.42, 55, 55, 82.41, 65.41];
  const lead = [196, 220, 233.08, 246.94, 261.63, 246.94, 233.08, 220];
  const tone = (freq: number, t: number, dur: number, type: OscillatorType, gain: number) => {
    if (!ctx || !master) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  };
  const tick = () => {
    if (!ctx || muted) return;
    const t = ctx.currentTime, i = step % 8;
    tone(bass[i]!, t, 0.28, "triangle", 0.05);
    if (i % 2 === 0) tone(lead[i]! / 2, t, 0.14, "square", 0.018);
    step += 1;
  };
  return {
    async unlock() {
      try {
        if (!ctx) {
          const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          if (!AC) return;
          ctx = new AC(); master = ctx.createGain(); master.gain.value = muted ? 0 : 0.4; master.connect(ctx.destination);
        }
        if (ctx.state === "suspended") await ctx.resume();
        if (timer == null) { timer = window.setInterval(tick, 300); tick(); }
      } catch { /* audio never blocks play */ }
    },
    setMuted(next: boolean) { muted = next; if (master) master.gain.value = muted ? 0 : 0.4; },
    stop() { if (timer != null) window.clearInterval(timer); timer = null; void ctx?.close().catch(() => {}); ctx = null; master = null; },
  };
}

/* ------------------------------------------------------------------ */
/* Game                                                                */
/* ------------------------------------------------------------------ */

type Hud = {
  foeHp: number; foeMax: number; bars: number; bar: number; barHp: number; barMax: number; breaks: number; ended: "won" | "lost" | null;
  playerHp: number; shield: number; shieldMax: number; beam: number;
  cadence: Cadence; window: "perfect" | "wind" | "open"; feedback: string; feedbackKind: string; timed: number;
};
const emptyHud: Hud = { foeHp: 0, foeMax: 1, bars: 2, bar: 1, barHp: 100, barMax: 100, breaks: 0, ended: null, playerHp: PLAYER_HP, shield: 0, shieldMax: 0, beam: 0, cadence: "open", window: "open", feedback: "", feedbackKind: "info", timed: 0 };

type Result = { won: boolean; diff: Difficulty; clearMs: number; damage: number; timed: number; early: number; late: number; shield: boolean; score: Score | null; rank: number | null };

export default function DungeonRaid({ friendId, client, paused }: GameComponentProps) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>("title");
  const [menu, setMenu] = useState<Menu>(null);
  const [diff, setDiff] = useState<Difficulty>("normal");
  const [boardTab, setBoardTab] = useState<Difficulty>("normal");
  const [shieldArmed, setShieldArmed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hud, setHud] = useState<Hud>(emptyHud);
  const [result, setResult] = useState<Result | null>(null);
  const [boardVersion, setBoardVersion] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLCanvasElement | null>(null);
  const fight = useRef<Fight | null>(null);
  const sound = useRef<FriendSoundKit | null>(null);
  const music = useRef<ReturnType<typeof createMusic> | null>(null);
  const audioReady = useRef(false);
  const locked = useRef(false);
  const epoch = useRef(0);
  const hudKey = useRef("");
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const screenRef = useRef(screen); screenRef.current = screen;
  const menuRef = useRef(menu); menuRef.current = menu;
  const reducedRef = useRef(reduced); reducedRef.current = reduced;
  const mutedRef = useRef(muted); mutedRef.current = muted;
  const friendRef = useRef(friendId); friendRef.current = friendId;

  const ensureAudio = useCallback(() => {
    if (mutedRef.current) return;
    if (!audioReady.current) audioReady.current = true;
    void sound.current?.unlock();
    void music.current?.unlock();
  }, []);

  const say = (f: Fight, text: string, kind = "info", t = 1.1) => { f.feedback = text; f.feedbackKind = kind; f.feedbackT = t; };
  const popup = (f: Fight, x: number, y: number, text: string, color: string, scale: Popup["scale"] = "md") => {
    f.popups.push({ x, y, text, color, life: scale === "lg" ? 1.0 : 0.85, scale });
  };
  const burst = (f: Fight, x: number, y: number, color: string, n: number) => {
    for (let i = 0; i < n; i++) f.particles.push({ x, y, vx: (Math.random() - 0.5) * 2.4, vy: (Math.random() - 0.7) * 2.4, life: 0.35 + Math.random() * 0.35, color });
  };

  const syncHud = useCallback((f: Fight) => {
    const broken = brokenBars(f);
    const bar = Math.min(f.bars, broken + 1);
    const barHp = Math.max(0, Math.ceil(f.foeHp - (f.bars - bar) * f.barHp));
    const t = tune(f.diff, broken);
    const win: Hud["window"] = f.cadence === "open" ? "open" : f.guard === "none" && f.timer <= t.perfect ? "perfect" : "wind";
    const next: Hud = {
      foeHp: Math.max(0, Math.ceil(f.foeHp)), foeMax: f.foeMax, bars: f.bars, bar, barHp, barMax: f.barHp, breaks: f.breaks,
      ended: f.live ? null : f.foeHp <= 0 ? "won" : "lost",
      playerHp: Math.max(0, Math.ceil(f.playerHp)), shield: Math.max(0, Math.ceil(f.shield)), shieldMax: f.shieldMax,
      beam: f.beam, cadence: f.cadence, window: win,
      feedback: f.feedbackT > 0 ? f.feedback : "", feedbackKind: f.feedbackKind, timed: f.timed,
    };
    const key = JSON.stringify(next);
    if (key !== hudKey.current) { hudKey.current = key; setHud(next); }
  }, []);

  const endFight = useCallback((f: Fight, won: boolean) => {
    if (!f.live) return;
    f.live = false;
    const clearMs = Math.round(f.elapsed * 1000);
    let score: Score | null = null, rank: number | null = null;
    if (won) {
      score = scoreRun(f.diff, clearMs, f.damageTaken, f.timed);
      rank = board.add({ friendId: friendRef.current.toString(), diff: f.diff, score: score.total, clearMs, damage: Math.round(f.damageTaken), timed: f.timed, shield: f.usedShield, at: Date.now() });
      setBoardVersion(v => v + 1);
      setBoardTab(f.diff);
      sound.current?.play("reveal-rare");
    } else {
      sound.current?.play("impact");
    }
    setResult({ won, diff: f.diff, clearMs, damage: Math.round(f.damageTaken), timed: f.timed, early: f.early, late: f.late, shield: f.usedShield, score, rank });
    syncHud(f); // swap the OPEN / INCOMING banner for VICTORY / DEFEATED on this frame
    window.setTimeout(() => { if (fight.current === f) setScreen(won ? "victory" : "defeat"); }, won ? 1300 : 1100);
  }, [syncHud]);

  const hurtPlayer = useCallback((f: Fight, dmg: number) => {
    let left = dmg;
    if (f.shield > 0) { const a = Math.min(f.shield, left); f.shield -= a; left -= a; }
    f.playerHp -= left;
    f.damageTaken += dmg;
    f.playerFlash = 0.25;
    f.shake = reducedRef.current ? 0 : Math.max(f.shake, 10);
    if (f.playerHp <= 0) { f.playerHp = 0; f.hitStop = 0.18; endFight(f, false); }
  }, [endFight]);

  const hitFoe = useCallback((f: Fight, dmg: number) => {
    const before = brokenBars(f);
    f.foeHp = Math.max(0, f.foeHp - dmg);
    f.foeFlash = 0.14;
    if (!reducedRef.current) f.shake = Math.max(f.shake, 4);
    const after = brokenBars(f);
    if (after > before) { f.breaks += after - before; f.breakFx = 0.42; f.hitStop = Math.max(f.hitStop, 0.08); }
    if (f.foeHp <= 0) { f.hitStop = 0.22; say(f, "Shade Moth defeated", "good", 3); endFight(f, true); return; }
    if (after > before) {
      say(f, `Bar ${before + 1} broken. Moth staggers.`, "good", 1.3);
      // stagger: extra OPEN time
      if (f.cadence === "open") f.timer += 0.7;
      else { f.cadence = "open"; f.timer = tune(f.diff, after).open + 0.4; f.guard = "none"; f.doublePending = false; }
    }
  }, [endFight]);

  // positions shared by input fx and the renderer
  const layout = useRef({ w: 640, h: 360, bx: 400, by: 140, bs: 2.5, px: 100, py: 260, ps: 96 });

  const act = useCallback((kind: "attack" | "guard" | "beam") => {
    const f = fight.current;
    if (!f?.live || pausedRef.current || menuRef.current || screenRef.current !== "play") return;
    ensureAudio();
    const L = layout.current;
    const t = tune(f.diff, brokenBars(f));
    if (kind === "attack") {
      if (f.attackCd > 0) return;
      f.attackCd = ATTACK_CD;
      if (f.cadence === "open") {
        hitFoe(f, ATTACK_DMG);
        burst(f, L.bx, L.by + 8 * L.bs, "#CCFF00", 6);
        popup(f, L.bx + (Math.random() - 0.5) * 40, L.by - 10, `-${ATTACK_DMG}`, "#CCFF00");
        sound.current?.play("action-start");
        if (f.live && f.feedbackKind !== "good") say(f, "Hit", "info", 0.4);
      } else {
        hitFoe(f, 1);
        hurtPlayer(f, t.counter);
        popup(f, L.px, L.py - L.ps * 0.6, `-${t.counter}`, "#ED927E");
        say(f, "Punished: don't attack on INCOMING", "bad", 1.1);
        sound.current?.play("impact");
      }
    } else if (kind === "guard") {
      if (f.cadence === "incoming") {
        if (f.guard !== "none") return;
        if (f.guardCd > 0) { say(f, "Guard recovering", "bad", 0.6); return; }
        if (f.timer <= t.perfect) {
          f.guard = "timed";
          f.timed += 1;
          const was = f.beam;
          f.beam = Math.min(BEAM_NEED, f.beam + 1);
          sound.current?.play(f.beam >= BEAM_NEED && was < BEAM_NEED ? "reveal-common" : "action-ready");
          say(f, f.beam >= BEAM_NEED ? "Timed guard! Rare Beam ready" : `Timed guard! Rare Beam ${f.beam}/${BEAM_NEED}`, "good", 1.2);
          burst(f, L.px + L.ps * 0.5, L.py, "#7DB4DB", 10);
        } else {
          f.guard = "early";
          f.early += 1;
          say(f, "Guarded too early", "bad", 1.1);
        }
      } else {
        if (f.guardCd > 0) return;
        f.guardCd = GUARD_WHIFF_CD;
        if (f.elapsed - f.lastImpact < LATE_WINDOW) { f.late += 1; say(f, "Too late", "bad", 1.0); }
        else { f.early += 1; say(f, "Guarded too early", "bad", 1.0); }
      }
    } else {
      if (f.beam < BEAM_NEED) { say(f, "Rare Beam locked: land timed guards", "bad", 0.9); return; }
      f.beam = 0;
      if (f.cadence === "open") {
        const dmg = ATTACK_DMG * BEAM_MULT;
        hitFoe(f, dmg);
        burst(f, L.bx, L.by + 4 * L.bs, "#CCFF00", 36);
        burst(f, L.bx, L.by + 4 * L.bs, "#EEEEEE", 18);
        popup(f, L.bx + 18, L.by - 18, `-${dmg}`, "#CCFF00", "md");
        f.beamFx = 0.4;
        f.foeFlash = 0.32;
        f.hitStop = Math.max(f.hitStop, 0.16);
        f.shake = reducedRef.current ? 0 : 14;
        sound.current?.play("reveal-rare");
        if (f.live) say(f, `Rare Beam! ${BEAM_MULT}x damage`, "good", 1.1);
      } else {
        hitFoe(f, ATTACK_DMG);
        popup(f, L.bx, L.by - 30, `-${ATTACK_DMG}`, "#B3A0D8");
        say(f, "Rare Beam wasted: use it on OPEN", "bad", 1.1);
        sound.current?.play("impact");
      }
    }
    syncHud(f);
  }, [ensureAudio, hitFoe, hurtPlayer, syncHud]);

  // session lifecycle
  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: false });
    music.current = createMusic();
    setSnapshot(null); setError(""); setMessage(""); setBusy(false); locked.current = false; audioReady.current = false;
    setScreen("title"); setMenu(null); setShieldArmed(false); setResult(null); fight.current = null;
    void client.read().then(v => { if (version === epoch.current) setSnapshot(v); }).catch(c => {
      if (version === epoch.current) setError(c instanceof Error ? c.message : "Could not load Dungeon Raid.");
    });
    const pref = window.matchMedia("(prefers-reduced-motion: reduce)");
    const upd = () => setReduced(pref.matches); upd(); pref.addEventListener("change", upd);
    return () => {
      epoch.current += 1;
      sound.current?.dispose(); sound.current = null;
      music.current?.stop(); music.current = null;
      pref.removeEventListener("change", upd);
      fight.current = null;
    };
  }, [client, friendId]);

  useEffect(() => { sound.current?.setMuted(muted); music.current?.setMuted(muted); }, [muted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (screenRef.current !== "play" || menuRef.current || pausedRef.current || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "1" || k === "j") { e.preventDefault(); act("attack"); }
      else if (k === "g" || k === "2" || k === " " || k === "k") { e.preventDefault(); act("guard"); }
      else if (k === "r" || k === "3" || k === "l") { e.preventDefault(); act("beam"); }
      else if (k === "escape") { e.preventDefault(); setMenu("quit"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  // render + simulation loop (only while the play screen is mounted)
  useEffect(() => {
    if (screen !== "play") return;
    const canvas = canvasRef.current, wrap = arenaRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !wrap) return;
    let raf = 0, last = performance.now();
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(200, wrap.clientWidth), h = Math.max(140, wrap.clientHeight);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      // Narrow phones use the stacked layout even when Safari's toolbars make the arena short.
      const portrait = w < 560 || h > w * 0.85;
      // Character Spotlight: Friend reads large next to the moth
      const ps = Math.round(clamp(Math.min(w, h) * (portrait ? 0.34 : 0.40), 72, 168));
      if (portrait) {
        const bs = Math.min((w * 0.78) / 116, (h * 0.58) / 80);
        const mothH = 77.3 * bs;
        const by = Math.min(h * 0.50, Math.max(h * 0.34, 54 + mothH / 2));
        layout.current = { w, h, bx: w * (h > w * 1.05 ? 0.58 : 0.62), by, bs, px: w * 0.22, py: h - ps * 0.58, ps };
      } else {
        const bs = Math.min((w * 0.46) / 116, (h * 0.58) / 80);
        layout.current = { w, h, bx: w * 0.64, by: h * (h < 260 ? 0.56 : 0.46), bs: h < 260 ? Math.min((w * 0.46) / 116, (h * 0.72) / 80) : bs, px: w * 0.18, py: h - ps * 0.58, ps };
      }
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const f = fight.current;
      const L = layout.current;
      const dpr = canvas.width / L.w;
      const visible = !!f && screenRef.current === "play" && !pausedRef.current && !menuRef.current && !document.hidden;
      // hit-stop freezes the fight (and the clock) for a few frames; effects keep drawing
      const frozen = visible && f!.hitStop > 0;
      if (frozen) f!.hitStop = Math.max(0, f!.hitStop - dt);
      if (f && visible && f.live && !frozen) {
        f.elapsed += dt;
        f.timer -= dt;
        f.attackCd = Math.max(0, f.attackCd - dt);
        f.guardCd = Math.max(0, f.guardCd - dt);
        if (f.cadence === "open" && f.timer <= 0) {
          const t = tune(f.diff, brokenBars(f));
          f.cadence = "incoming"; f.wind = t.wind; f.timer = t.wind; f.guard = "none";
          f.doublePending = Math.random() < t.double;
          say(f, "INCOMING: Guard on the lime cue", "warn", 0.9);
          sound.current?.play("anticipation");
        } else if (f.cadence === "incoming" && f.timer <= 0) {
          const t = tune(f.diff, brokenBars(f));
          f.lastImpact = f.elapsed;
          f.strikeFx = 0.22; f.strikeBlocked = f.guard === "timed";
          if (f.guard === "timed") {
            popup(f, L.px + L.ps * 0.55, L.py - L.ps * 0.75, "BLOCK", "#7DB4DB", "sm");
            sound.current?.play("action-ready");
          } else if (f.guard === "early") {
            hurtPlayer(f, t.early);
            popup(f, L.px, L.py - L.ps * 0.7, `-${t.early}`, "#ED927E");
            sound.current?.play("impact");
          } else {
            hurtPlayer(f, t.hit);
            popup(f, L.px, L.py - L.ps * 0.7, `-${t.hit}`, "#ED927E");
            if (f.live) say(f, "Hit! Guard when the ring turns lime", "bad", 1.1);
            sound.current?.play("impact");
          }
          if (f.live) {
            if (f.doublePending) {
              f.doublePending = false;
              f.cadence = "incoming"; f.wind = t.wind * 0.8; f.timer = f.wind; f.guard = "none";
              say(f, "Double strike: guard again", "warn", 0.9);
            } else {
              f.cadence = "open"; f.timer = t.open + (f.guard === "timed" ? 0.25 : 0); f.guard = "none";
            }
          }
        }
        if (f.feedbackT > 0) f.feedbackT -= dt;
        f.wing += dt * (f.cadence === "incoming" ? 10 : 4);
        syncHud(f);
      }
      if (f && visible && !frozen) {
        // effects run on after the killing blow so the defeat animation and numbers play out
        f.clock += dt;
        f.playerFlash = Math.max(0, f.playerFlash - dt);
        f.foeFlash = Math.max(0, f.foeFlash - dt);
        f.strikeFx = Math.max(0, f.strikeFx - dt);
        f.breakFx = Math.max(0, f.breakFx - dt);
        f.beamFx = Math.max(0, f.beamFx - dt);
        f.shake = Math.max(0, f.shake - dt * 30);
        if (!f.live) f.wing += dt * 1.5;
        for (const p of f.particles) { p.x += p.vx * 60 * dt; p.y += p.vy * 60 * dt; p.vy += 4 * dt; p.life -= dt; }
        f.particles = f.particles.filter(p => p.life > 0);
        for (const p of f.popups) { p.y -= 34 * dt; p.life -= dt; }
        f.popups = f.popups.filter(p => p.life > 0);
      }
      // draw
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { w, h } = L;
      const cell = cellSize(116 * L.bs);
      const gy = h - Math.min(56, h * 0.12);
      const mothTop = L.by - (77.3 * L.bs) / 2;
      const torchY = Math.max(46, Math.min(mothTop + cell, gy - cell * 16));
      const spec: DungeonSpec = { w: Math.ceil(w), h: Math.ceil(h), cell, floorY: gy, archX: L.bx, archW: 116 * L.bs * 0.62, archTop: mothTop + cell * 3,
        torches: [{ x: cell * 4, y: torchY }, { x: w - cell * 4, y: torchY }] };
      // pixel-snapped screen shake (whole cells), applied to the whole scene
      const k = f && f.shake > 0.5 ? Math.max(1, Math.round(f.shake / 6)) : 0;
      const sx = k ? Math.round((Math.random() - 0.5) * 2 * k) * cell : 0, sy = k ? Math.round((Math.random() - 0.5) * 2 * k) * cell : 0;
      ctx.save(); ctx.translate(sx, sy);
      drawDungeon(ctx, spec, reducedRef.current ? 0 : Math.floor((f?.clock ?? now / 1000) / 0.17));
      if (f) {
        const t = tune(f.diff, brokenBars(f));
        // effects share the Friend sprite's pixel size (sprite is 16 cells across)
        const pc = Math.max(3, Math.round(L.ps / 16));
        // boss strike: a chunky pixel dotted line
        if (f.strikeFx > 0) {
          ctx.fillStyle = f.strikeBlocked ? "#7DB4DB" : "#ED927E"; ctx.globalAlpha = clamp(f.strikeFx * 5, 0, 1);
          pixelLine(ctx, L.bx, L.by + 6 * L.bs, L.px + (f.strikeBlocked ? L.ps * 0.75 : 0), L.py, pc);
          ctx.globalAlpha = 1;
        }
        const bossMode = !f.live && f.foeHp <= 0 ? "defeat" : !f.live ? "idle" : f.cadence;
        const cellB = cellSize(116 * L.bs);
        const coreX = L.bx, coreY = L.by + 2 * cellB;
        // Rare Beam: thick lime beam Friend → moth core (drawn under the moth flash)
        if (f.beamFx > 0) {
          const fade = clamp(f.beamFx / 0.4, 0, 1);
          ctx.globalAlpha = 0.35 + 0.65 * fade;
          const fromX = L.px + L.ps * 0.4, fromY = L.py - L.ps * 0.15;
          ctx.fillStyle = "#111111";
          pixelBeam(ctx, fromX, fromY, coreX, coreY, cellB, 7);
          ctx.fillStyle = "#CCFF00";
          pixelBeam(ctx, fromX, fromY, coreX, coreY, cellB, 5);
          ctx.fillStyle = "#EEEEEE";
          pixelBeam(ctx, fromX, fromY, coreX, coreY, cellB, 2);
          ctx.globalAlpha = 1;
        }
        drawBoss(ctx, L.bx, L.by, L.bs, f.wing, { flash: Math.max(f.foeFlash, f.beamFx > 0.2 ? 0.35 : 0), reduced: reducedRef.current, mode: bossMode, openPulse: f.elapsed });
        if (f.beamFx > 0) {
          const pulse = f.beamFx > 0.28 ? 1 : f.beamFx > 0.14 ? 0.7 : f.beamFx * 3;
          ctx.globalAlpha = pulse;
          // impact burst on weak spot
          ctx.fillStyle = "#EEEEEE";
          const r0 = 7 * cellB;
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + f.clock * 4;
            const rr = r0 * (0.55 + 0.45 * (i % 3) / 2);
            ctx.fillRect(Math.round((coreX + Math.cos(a) * rr) / cellB) * cellB - cellB, Math.round((coreY + Math.sin(a) * rr) / cellB) * cellB - cellB, cellB * 2, cellB * 2);
          }
          ctx.fillStyle = "#CCFF00";
          const cw = 8 * cellB, ch = 6 * cellB;
          ctx.fillRect(Math.round(coreX - cw / 2), Math.round(coreY - ch / 2), Math.round(cw), Math.round(ch));
          ctx.fillStyle = "#EEEEEE";
          ctx.fillRect(Math.round(coreX - cw / 4), Math.round(coreY - ch / 4), Math.round(cw / 2), Math.round(ch / 2));
          ctx.globalAlpha = 1;
          // small RARE BEAM tag near impact (not a screen-filling word)
          drawPixelText(ctx, "RARE BEAM", coreX, coreY - 12 * cellB, 2, "#CCFF00");
        }
        // player
        const sprite = spriteRef.current;
        const pl = L.px - L.ps / 2, pt = L.py - L.ps / 2;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(Math.round(L.px - L.ps * 0.36), Math.round(L.py + L.ps * 0.42), Math.round(L.ps * 0.72), pc);
        if (sprite) { ctx.imageSmoothingEnabled = false; ctx.drawImage(sprite, pl, pt, L.ps, L.ps); }
        if (f.playerFlash > 0) { ctx.fillStyle = "rgba(237,146,126,0.45)"; roundRect(ctx, pl, pt, L.ps, L.ps); ctx.fill(); }
        if (f.shield > 0) {
          ctx.fillStyle = "#7DB4DB"; ctx.globalAlpha = 0.85;
          pixelArc(ctx, L.px, L.py, L.ps * 0.64, pc, 0, Math.PI * 2, true); ctx.globalAlpha = 1;
        }
        if (f.guard === "timed" || (f.strikeFx > 0 && f.strikeBlocked)) {
          ctx.fillStyle = "#7DB4DB";
          pixelArc(ctx, L.px, L.py, L.ps * 0.74, pc, -0.95, 0.95);
          pixelArc(ctx, L.px, L.py, L.ps * 0.74 + pc, pc, -0.8, 0.8);
        }
        // guard timing ring: pixel ring closes on the Friend, turns lime inside the timed-guard window
        if (f.cadence === "incoming" && f.live) {
          const rMin = L.ps * 0.64, rMax = L.ps * 1.9;
          const kk = clamp(f.timer / f.wind, 0, 1);
          const perfect = f.timer <= t.perfect;
          ctx.fillStyle = "rgba(204,255,0,0.85)";
          pixelArc(ctx, L.px, L.py, rMin, Math.max(2, pc - 1), 0, Math.PI * 2, true);
          ctx.fillStyle = perfect && f.guard === "none" ? "#CCFF00" : f.guard === "early" ? "#8a8a8a" : "#ED927E";
          const r = rMin + (rMax - rMin) * kk;
          pixelArc(ctx, L.px, L.py, r, pc);
          if (perfect && f.guard === "none") pixelArc(ctx, L.px, L.py, r + pc, pc);
        }
        for (const p of f.particles) { ctx.globalAlpha = clamp(p.life * 2.5, 0, 1); ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x / pc) * pc, Math.round(p.y / pc) * pc, pc, pc); }
        ctx.globalAlpha = 1;
        // floating combat text: compact pixel font (sm/md/lg), ink+paper outline
        const tc = Math.round(clamp(w / 170, 2, 4));
        const scaleCell = { sm: Math.max(2, tc - 1), md: tc, lg: Math.min(5, tc + 1) } as const;
        for (const p of f.popups) {
          if (p.life < 0.1 && Math.floor(p.life * 40) % 2) continue;
          const c = scaleCell[p.scale];
          const x = clamp(p.x, textCells(p.text) * c / 2 + c * 2, w - textCells(p.text) * c / 2 - c * 2);
          drawPixelText(ctx, p.text, x, p.y - 7 * c, c, p.color);
        }
        // bar break: brief flash + compact callout
        if (f.breakFx > 0) {
          const step = f.breakFx > 0.34 ? 0.4 : f.breakFx > 0.26 ? 0 : f.breakFx > 0.18 ? 0.22 : 0;
          if (step && !reducedRef.current) { ctx.globalAlpha = step; ctx.fillStyle = "#EEEEEE"; ctx.fillRect(-cell * 3, -cell * 3, w + cell * 6, h + cell * 6); ctx.globalAlpha = 1; }
          if (f.live) drawPixelText(ctx, "BAR BROKEN", w / 2, L.by + (77.3 * L.bs) / 2 - tc * 3, Math.max(2, tc), "#F2CE68");
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [screen, syncHud, hurtPlayer]);

  async function runAction(work: () => Promise<void>, cue?: FriendSoundCue) {
    if (locked.current || paused) return;
    const version = epoch.current;
    locked.current = true; setBusy(true); setError(""); setMessage(""); ensureAudio();
    try {
      await work();
      const value = await client.read();
      if (version === epoch.current) { setSnapshot(value); if (cue) sound.current?.play(cue); }
    } catch (cause) {
      if (version === epoch.current) {
        setError(cause instanceof Error ? cause.message : "The preview action failed.");
        void client.read().then(v => { if (version === epoch.current) setSnapshot(v); }).catch(() => {});
      }
    } finally {
      if (version === epoch.current) { locked.current = false; setBusy(false); }
    }
  }

  const startFight = (d: Difficulty = diff) => {
    ensureAudio();
    const useShield = d === "max" && shieldArmed;
    if (useShield) setShieldArmed(false);
    const f = makeFight(d, useShield);
    fight.current = f;
    hudKey.current = "";
    syncHud(f);
    setResult(null); setMenu(null); setDiff(d);
    setScreen("play");
    sound.current?.play("action-start");
  };

  const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

  if (!snapshot) {
    return (
      <div className="nr-loading" role={error ? "alert" : "status"}>
        <span>{error || "Loading Dungeon Raid..."}</span>
        {error && <button type="button" onClick={() => { setError(""); void client.read().then(setSnapshot).catch(c => setError(c instanceof Error ? c.message : "Could not load Dungeon Raid.")); }}>Retry</button>}
      </div>
    );
  }
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;

  const price = client.definition.price;
  const salvage = client.definition.outcomes[0]!;
  const ownedShields = snapshot.consumables;
  const pendingPlay = snapshot.plays.find(p => p.outcomeId === null);
  const scales = snapshot.inventory[0] ?? 0n;
  const canAfford = snapshot.rfBalance >= price && snapshot.freeStake >= salvage.reward;

  const equipShield = () => void runAction(async () => {
    const version = epoch.current;
    const snap = await client.read();
    let open = snap.plays.find(p => p.outcomeId === null);
    if (!open) {
      if (snap.consumables <= 0n) await client.buy(1n);
      open = (await client.play(1n))[0];
    }
    if (!open) throw new Error("Shield Bar could not be used.");
    await client.settle(open.id);
    if (version === epoch.current) { setShieldArmed(true); setMessage("Shield Bar armed for your next Max fight (SIMULATED)."); }
  }, "purchase");

  const redeemScales = () => void runAction(async () => {
    await client.redeem(1, scales);
    setMessage(`Redeemed ${scales.toString()} Moth Scale for ${rf(salvage.reward * scales)} (SIMULATED).`);
  }, "reward");

  const status = (
    <p className={`nr-status${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
      {error || message || (busy ? "Waiting for the preview confirmation..." : "\u00a0")}
    </p>
  );

  const shieldPanel = (
    <div className="nr-shield" aria-label="Shield Bar">
      <div className="nr-shield-text">
        <strong>Shield Bar</strong> <span>Max only, optional: +{SHIELD_HP} HP layer that absorbs hits first.</span>
        <span className="nr-balance"> {rf(price)} credits <em className="nr-sim">SIMULATED</em> · Friend RF {rf(snapshot.rfBalance)}</span>
      </div>
      {shieldArmed
        ? <span className="nr-armed">Shield armed for next Max fight</span>
        : <button type="button" className="nr-small" disabled={busy || paused || (!pendingPlay && ownedShields <= 0n && !canAfford)} onClick={equipShield}>
            {pendingPlay ? "Resume Shield Bar" : ownedShields > 0n ? "Equip owned Shield Bar" : `Buy Shield Bar (${rf(price)})`}
          </button>}
      {scales > 0n && (
        <div className="nr-shield-row">
          <span className="nr-balance">Used shields leave {scales.toString()} Moth Scale ({rf(salvage.reward)} each)</span>
          <button type="button" className="nr-small" disabled={busy || paused} onClick={redeemScales}>Redeem</button>
        </div>
      )}
    </div>
  );

  const bossBars = (
    <div className="nr-panel nr-boss-panel" key={`boss-${hud.breaks}`} data-broke={hud.breaks > 0 ? "1" : "0"}>
      <div className="nr-panel-head">
        <strong>{BOSS}</strong>
        <span className="nr-tag">Bar {hud.bar}/{hud.bars}</span>
      </div>
      <div className="nr-bar nr-bar-boss" role="meter" aria-label={`${BOSS} bar ${hud.bar} of ${hud.bars}`} aria-valuemin={0} aria-valuemax={hud.barMax} aria-valuenow={hud.barHp}>
        <i style={{ width: `${(hud.barHp / hud.barMax) * 100}%` }} />
        <b>{hud.barHp}/{hud.barMax}</b>
      </div>
      <div className="nr-pips" aria-hidden="true">
        {Array.from({ length: hud.bars }, (_, i) => {
          const idx = i + 1; // bar 1 is the first to break
          const state = idx < hud.bar ? "gone" : idx === hud.bar ? "live" : "full";
          return <span key={i} data-state={state} />;
        })}
      </div>
    </div>
  );

  const beamReady = hud.beam >= BEAM_NEED;
  const playerBars = (
    <div className="nr-panel nr-player-panel">
      <div className="nr-panel-head">
        <strong>Friend #{friendId.toString()}</strong>
        <span className="nr-tag">{DIFF[diff].label}</span>
      </div>
      {hud.shieldMax > 0 && (
        <div className="nr-bar nr-bar-shield" role="meter" aria-label="Shield" aria-valuemin={0} aria-valuemax={hud.shieldMax} aria-valuenow={hud.shield}>
          <i style={{ width: `${(hud.shield / hud.shieldMax) * 100}%` }} />
          <b>Shield {hud.shield}/{hud.shieldMax}</b>
        </div>
      )}
      <div className="nr-bar nr-bar-hp" role="meter" aria-label="Friend HP" aria-valuemin={0} aria-valuemax={PLAYER_HP} aria-valuenow={hud.playerHp}>
        <i style={{ width: `${(hud.playerHp / PLAYER_HP) * 100}%` }} />
        <b>HP {hud.playerHp}/{PLAYER_HP}</b>
      </div>
      <div className="nr-beam-meter" aria-label={`Rare Beam charge ${hud.beam} of ${BEAM_NEED}`}>
        <span>Rare Beam</span>
        {Array.from({ length: BEAM_NEED }, (_, i) => <i key={i} data-on={i < hud.beam ? "1" : "0"} />)}
        <em>{beamReady ? "READY" : `${hud.beam}/${BEAM_NEED} timed guards`}</em>
      </div>
    </div>
  );

  const banner = hud.ended === "won" ? { kind: "victory", text: "VICTORY", sub: "Shade Moth defeated" }
    : hud.ended === "lost" ? { kind: "defeat", text: "DEFEATED", sub: "Your Friend is down" }
    : hud.cadence === "open"
    ? { kind: "open", text: "OPEN", sub: "Attack" }
    : hud.window === "perfect" ? { kind: "perfect", text: "GUARD NOW", sub: "Timed guard" } : { kind: "incoming", text: "INCOMING", sub: "Get ready to Guard" };

  const leaderboard = (tab: Difficulty) => {
    const rows = board.list(tab).slice(0, 10);
    return (
      <div className="nr-board" data-version={boardVersion}>
        <div className="nr-tabs" role="tablist" aria-label="Leaderboard difficulty">
          {(["normal", "max"] as const).map(d => (
            <button key={d} type="button" role="tab" aria-selected={tab === d} className={tab === d ? "is-on" : ""} onClick={() => setBoardTab(d)}>
              {DIFF[d].label}
            </button>
          ))}
        </div>
        <p className="nr-local">
          <strong>LOCAL</strong> {board.persistent ? "Saved in this browser only." : "This session only: the game sandbox blocks storage, so scores clear on reload."} Real runs only, no seeded scores.
        </p>
        {rows.length === 0
          ? <p className="nr-empty">No {DIFF[tab].label} clears yet. Win a raid to post the first score.</p>
          : (
            <ol className="nr-rows">
              {rows.map((r, i) => (
                <li key={`${r.at}-${i}`} className={r.friendId === friendId.toString() ? "is-you" : ""}>
                  <span className="nr-rank">{i + 1}</span>
                  <span className="nr-who">Friend #{r.friendId}{r.shield ? <small>Shield</small> : null}</span>
                  <span className="nr-score">{r.score.toLocaleString("en-US")}</span>
                  <span className="nr-meta">{fmt(r.clearMs)} · -{r.damage} HP · {r.timed} TG</span>
                </li>
              ))}
            </ol>
          )}
      </div>
    );
  };

  const f = fight.current;
  return (
    <section
      className="nr-game"
      aria-label="Dungeon Raid"
      aria-busy={busy}
      data-screen={screen}
      data-diff={diff}
      data-cadence={screen === "play" ? (hud.ended ? "ended" : hud.cadence) : ""}
      data-window={screen === "play" ? hud.window : ""}
      data-beam={screen === "play" ? hud.beam : 0}
    >
      <div className="nr-sprite-slot" aria-hidden="true">
        <FriendCanvas friendId={friendId} reduced={reduced} canvasRef={spriteRef} size={128} active={screen === "play"} />
      </div>

      {screen === "title" && (
        <div className="nr-screen nr-title">
          <div className="nr-hero nr-card">
            <TitleScene reduced={reduced} />
            <div className="nr-hero-friend" aria-label={`Your Friend #${friendId.toString()}`}>
              <span className="nr-hero-friend-tag">Your Friend</span>
              <FriendCanvas friendId={friendId} reduced={reduced} size={72} />
              <span className="nr-hero-friend-id">#{friendId.toString()}</span>
            </div>
          </div>
          <div className="nr-title-side">
          <h1 className="nr-sr">Dungeon Raid</h1>
          <p className="nr-sub">Your Generations Friend raids the dungeon vs {BOSS}</p>
          <p className="nr-pitch">Play as your Rare Friend. Timed Guard charges Rare Beam. Clear Normal or Max.</p>
          <div className="nr-modes" role="group" aria-label="Start a raid">
            {(["normal", "max"] as const).map(d => (
              <button key={d} type="button" className={`nr-mode${d === "normal" ? " nr-cta" : ""}`} disabled={paused || busy}
                aria-label={`Start ${DIFF[d].label} raid${d === "max" && shieldArmed ? " (Shield)" : ""}`}
                onClick={() => startFight(d)}>
                <strong>{DIFF[d].label.toUpperCase()}</strong>
                <span>{DIFF[d].blurb} · x{DIFF[d].mult}{d === "max" && shieldArmed ? " · Shield" : ""}</span>
              </button>
            ))}
          </div>
          {shieldPanel}
          <ol className="nr-how" aria-label="How to play">
            <li><b className="is-open">OPEN</b> Attack the moth.</li>
            <li><b className="is-in">INCOMING</b> Guard when the ring turns lime.</li>
            <li><b className="is-beam">{BEAM_NEED} timed guards</b> unlock Rare Beam: {BEAM_MULT}x on OPEN.</li>
          </ol>
          <div className="nr-actions nr-title-actions">
            <button type="button" disabled={busy} onClick={() => { setBoardTab(diff); setScreen("board"); }}>Leaderboard</button>
            <button type="button" disabled={busy} onClick={() => setMenu("help")}>Rules</button>
            <button type="button" disabled={busy} onClick={() => setMenu("settings")}>Settings</button>
          </div>
          {status}
          </div>
        </div>
      )}

      {screen === "play" && (
        <div className="nr-screen nr-play">
          <div className="nr-hud-top">
            {bossBars}
            {playerBars}
          </div>
          <div className="nr-arena" ref={arenaRef}>
            <canvas ref={canvasRef} className="nr-canvas" aria-label="Arena: Shade Moth versus your Friend" />
            <div className="nr-banner" data-kind={banner.kind} role="status" aria-live="polite">
              <strong>{banner.text}</strong><span>{banner.sub}</span>
            </div>
            <button type="button" className="nr-pause" onClick={() => setMenu("quit")} aria-label="Pause">Pause</button>
          </div>
          <div className="nr-feedback" data-kind={hud.feedbackKind} role="status">{hud.feedback || "\u00a0"}</div>
          <div className="nr-controls" role="group" aria-label="Combat actions">
            <button type="button" className={`nr-act${hud.cadence === "open" && !hud.ended ? " is-cue" : ""}`} disabled={paused || !!menu || !!hud.ended} onClick={() => act("attack")}>
              <strong>Attack</strong><small>A / 1</small>
            </button>
            <button type="button" className={`nr-act${hud.ended ? "" : hud.window === "perfect" ? " is-lit" : hud.cadence === "incoming" ? " is-warn" : ""}`} disabled={paused || !!menu || !!hud.ended} onClick={() => act("guard")}>
              <strong>Guard</strong><small>G / 2</small>
            </button>
            <button
              type="button"
              className={`nr-act nr-beam${beamReady && !hud.ended ? " is-lit" : " is-locked"}`}
              disabled={paused || !!menu || !beamReady || !!hud.ended}
              aria-label={beamReady ? "Rare Beam ready" : `Rare Beam locked, ${hud.beam} of ${BEAM_NEED} timed guards`}
              onClick={() => act("beam")}
            >
              <strong>Rare Beam</strong><small>{beamReady ? `${BEAM_MULT}x  R / 3` : `Locked ${hud.beam}/${BEAM_NEED}`}</small>
            </button>
          </div>
        </div>
      )}

      {(screen === "victory" || screen === "defeat") && result && (
        <div className={`nr-screen nr-end${result.won ? " is-won" : " is-lost"}`}>
          <div className="nr-card nr-end-card">
            <p className="nr-kicker">{DIFF[result.diff].label}{result.shield ? " with Shield" : ""} · Friend #{friendId.toString()}</p>
            <h2 className="nr-end-title">{result.won ? "Victory" : "Defeated"}</h2>
            <p className="nr-end-sub">{result.won ? "Dungeon cleared. The Shade Moth falls." : "Your Friend was downed in the dungeon."}</p>
            <p className="nr-pitch">Play as your Rare Friend. Timed Guard charges Rare Beam. Clear Normal or Max.</p>
            {result.won && result.score ? (
              <>
                <p className="nr-bigscore" aria-label={`Score ${result.score.total}`}>{result.score.total.toLocaleString("en-US")}</p>
                <dl className="nr-breakdown">
                  <dt>Base</dt><dd>{result.score.base}</dd>
                  <dt>Time {fmt(result.clearMs)}</dt><dd>+{result.score.time}</dd>
                  <dt>Timed guards {result.timed}</dt><dd>+{result.score.guards}</dd>
                  <dt>Damage taken {result.damage}</dt><dd>{result.score.damage}</dd>
                  <dt>Difficulty {DIFF[result.diff].label}</dt><dd>x{result.score.mult}</dd>
                </dl>
                <p className="nr-muted">{result.rank ? `Posted to the local ${DIFF[result.diff].label} leaderboard at #${result.rank}.` : `Recorded locally (outside the top ${LB_LIMIT}).`}</p>
              </>
            ) : (
              <p className="nr-muted">Timed guards {result.timed} · early {result.early} · late {result.late} · {fmt(result.clearMs)}. Wait for the ring to turn lime, guard, then fire Rare Beam on OPEN.</p>
            )}
            <div className="nr-actions">
              <button type="button" className="nr-cta" disabled={paused || busy} onClick={() => startFight(result.diff)}>
                {result.won ? "Play again" : "Try again"}
              </button>
              <button type="button" onClick={() => { setBoardTab(result.diff); setScreen("board"); }}>Leaderboard</button>
              <button type="button" onClick={() => setScreen("title")}>Title</button>
            </div>
          </div>
        </div>
      )}

      {screen === "board" && (
        <div className="nr-screen nr-board-screen">
          <div className="nr-card nr-board-card">
            <div className="nr-board-head">
              <h2>Leaderboard</h2>
              <button type="button" onClick={() => setScreen("title")}>Back</button>
            </div>
            {leaderboard(boardTab)}
            <p className="nr-muted">Score = (5000 + time bonus (6000 minus 100 per second) + 250 per timed guard - 15 per HP lost) x difficulty (Normal x1, Max x2.5).</p>
          </div>
        </div>
      )}

      {menu && (
        <GameMenu title={menu === "settings" ? "Settings" : menu === "help" ? "How to play" : "Paused"} onClose={() => setMenu(null)}>
          {menu === "help" && (
            <div className="nr-help">
              <p><strong>OPEN</strong> (lime): the moth is exposed. Tap <strong>Attack</strong>.</p>
              <p><strong>INCOMING</strong> (coral): a strike is coming. A ring closes on your Friend. Tap <strong>Guard</strong> when it turns lime (GUARD NOW) for a timed guard. Too early blocks only half, too late does nothing. Attacking during INCOMING gets you punished.</p>
              <p><strong>Rare Beam</strong> is locked until you land {BEAM_NEED} timed guards. Then it lights lime and hits for {BEAM_MULT}x Attack. Use it on OPEN.</p>
              <p><strong>Normal</strong>: 2 boss bars. <strong>Max</strong>: 4 bars, faster and double strikes. Before Max you may buy one Shield Bar ({rf(price)}, SIMULATED).</p>
              <p className="nr-muted">Keys: A / G / R or 1 / 2 / 3. Esc pauses.</p>
            </div>
          )}
          {menu === "settings" && (
            <div className="nr-actions">
              <button type="button" aria-pressed={muted} onClick={() => setMuted(m => !m)}>{muted ? "Sound off" : "Sound on"}</button>
              <button type="button" aria-pressed={reduced} onClick={() => setReduced(r => !r)}>{reduced ? "Reduce motion on" : "Reduce motion off"}</button>
            </div>
          )}
          {menu === "quit" && (
            <>
              <p>Fight paused{f ? ` at ${fmt(f.elapsed * 1000)}` : ""}.</p>
              <div className="nr-actions">
                <button type="button" className="nr-cta" onClick={() => setMenu(null)}>Resume</button>
                <button type="button" aria-pressed={muted} onClick={() => setMuted(m => !m)}>{muted ? "Sound off" : "Sound on"}</button>
                <button type="button" onClick={() => { if (fight.current) fight.current.live = false; setMenu(null); setScreen("title"); }}>Forfeit</button>
              </div>
            </>
          )}
        </GameMenu>
      )}
    </section>
  );
}
