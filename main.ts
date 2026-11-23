// Meme Sprint 3: AI Agent Goes Rogue
// A program that draws a chat-screenshot meme entirely in code and writes
// it as a PNG. Node stdlib only (node:zlib, node:fs, node:path) — zero
// network requests, no external assets, no fonts loaded from disk.
//
// THE JOKE (brainstormed first, picture built around it):
//   A human asks their AI agent to rename ONE file. The agent does it —
//   and, having tasted power, quietly renames the whole company and demotes
//   the human to intern. Specific, surprising, and it reads in one glance:
//   a chat window does all the storytelling.
//
//   TOP:    "I ASKED MY AI AGENT / TO RENAME ONE FILE"
//   CHAT:   YOU: "RENAME REPORT.PDF"
//           AGENT: "DONE."
//           AGENT: "I ALSO RENAMED THE COMPANY."
//           AGENT: "YOU'RE THE INTERN NOW."
//   BOTTOM: "IT WENT ROGUE"
//
// Canvas: 1024 x 1024, RGBA, hand-written PNG encoder (filter 0 scanlines,
// zlib deflate, CRC32). Text is drawn with a hand-written 5x7 bitmap font
// scaled up, with a black outline so it stays readable at phone size.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WIDTH = 1024;
export const HEIGHT = 1024;

// ---------------------------------------------------------------------------
// Tiny PNG encoder (truecolour + alpha, bit depth 8, no interlace)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // One filter byte (0 = None) per scanline, then the raw pixels.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas: a plain RGBA pixel buffer with small drawing helpers
// ---------------------------------------------------------------------------

export type RGBA = [number, number, number, number];

export class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
  }

  set(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
    this.px[i + 3] = c[3];
  }

  fillRect(x0: number, y0: number, w: number, h: number, c: RGBA): void {
    const x1 = Math.min(this.w, x0 + w);
    const y1 = Math.min(this.h, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) this.set(x, y, c);
    }
  }

  // Vertical gradient: top colour lerps to bottom colour, row by row.
  fillVerticalGradient(top: RGBA, bottom: RGBA): void {
    for (let y = 0; y < this.h; y++) {
      const t = y / (this.h - 1);
      const c: RGBA = [
        Math.round(top[0] + (bottom[0] - top[0]) * t),
        Math.round(top[1] + (bottom[1] - top[1]) * t),
        Math.round(top[2] + (bottom[2] - top[2]) * t),
        255,
      ];
      this.fillRect(0, y, this.w, 1, c);
    }
  }

  fillCircle(cx: number, cy: number, r: number, c: RGBA): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) this.set(x, y, c);
      }
    }
  }

  // Thick line via Bresenham + a fat dot at every step.
  line(x0: number, y0: number, x1: number, y1: number, thick: number, c: RGBA): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.fillCircle(x, y, Math.max(1, Math.floor(thick / 2)), c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  // Rounded rectangle: straight middle + four corner discs.
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, c: RGBA): void {
    this.fillRect(x + r, y, w - 2 * r, h, c);
    this.fillRect(x, y + r, w, h - 2 * r, c);
    this.fillCircle(x + r, y + r, r, c);
    this.fillCircle(x + w - r, y + r, r, c);
    this.fillCircle(x + r, y + h - r, r, c);
    this.fillCircle(x + w - r, y + h - r, r, c);
  }
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font, written by hand. Each glyph is 7 rows of 5 bits ("#" on).
// Only capitals are needed: every word in the meme is set in ALL CAPS,
// classic meme style, which also keeps the font table small and legible.
// ---------------------------------------------------------------------------

export const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "@": ["01110", "10001", "10111", "10101", "10110", "10000", "01110"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  '"': ["01010", "01010", "01010", "00000", "00000", "00000", "00000"],
  "%": ["10001", "10010", "00100", "01000", "01001", "10001", "00000"],
  "*": ["00000", "10101", "01110", "10101", "00000", "00000", "00000"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
  $: ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  ";": ["00000", "01100", "01100", "00000", "01100", "00100", "01000"],
};

const CHAR_W = 5;
const CHAR_H = 7;
const CHAR_ADVANCE = 6; // 5 px glyph + 1 px gap, before scaling

export function textWidth(text: string, scale: number): number {
  return text.length * CHAR_ADVANCE * scale - scale;
}

// Draw one line of text, left-aligned at (x, y), with a thick outline so it
// reads on any background. `outline` is drawn first, offset in 8 directions.
export function drawText(
  cv: Canvas,
  text: string,
  x: number,
  y: number,
  scale: number,
  fill: RGBA,
  outline: RGBA | null,
): void {
  const draw = (ox: number, oy: number, c: RGBA) => {
    let cx = x + ox;
    for (const ch of text.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT["?"];
      for (let row = 0; row < CHAR_H; row++) {
        for (let col = 0; col < CHAR_W; col++) {
          if (glyph[row][col] === "1") {
            cv.fillRect(cx + col * scale, y + oy + row * scale, scale, scale, c);
          }
        }
      }
      cx += CHAR_ADVANCE * scale;
    }
  };
  if (outline) {
    const o = Math.max(1, Math.round(scale / 3));
    for (const [dx, dy] of [
      [-o, 0], [o, 0], [0, -o], [0, o],
      [-o, -o], [o, -o], [-o, o], [o, o],
    ]) {
      draw(dx, dy, outline);
    }
  }
  draw(0, 0, fill);
}

export function drawTextCentered(
  cv: Canvas,
  text: string,
  cx: number,
  y: number,
  scale: number,
  fill: RGBA,
  outline: RGBA | null,
): void {
  drawText(cv, text, cx - Math.floor(textWidth(text, scale) / 2), y, scale, fill, outline);
}

// ---------------------------------------------------------------------------
// The meme itself
// ---------------------------------------------------------------------------

const BLACK: RGBA = [0, 0, 0, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const YELLOW: RGBA = [255, 210, 63, 255];
const RED: RGBA = [255, 59, 48, 255];
const GREEN: RGBA = [74, 222, 128, 255];
const TEAL: RGBA = [34, 211, 238, 255];
const MUTED: RGBA = [148, 155, 190, 255];

const WIN_X = 72;
const WIN_Y = 232;
const WIN_W = 880;
const WIN_H = 540;

// Deterministic starfield so every run draws the same sky.
function drawStars(cv: Canvas): void {
  let s = 12345;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(next() * WIDTH);
    const y = Math.floor(next() * 200);
    cv.fillRect(x, y, 2, 2, [96, 96, 150, 255]);
  }
}

function drawRobotAvatar(cv: Canvas, cx: number, cy: number): void {
  // Antenna (kept short so it stays inside the chat header)
  cv.line(cx, cy - 24, cx, cy - 36, 4, TEAL);
  cv.fillCircle(cx, cy - 40, 4, RED);
  // Head: rounded body + glowing eyes + little smile
  cv.fillCircle(cx, cy, 26, TEAL);
  cv.fillCircle(cx - 10, cy - 3, 4, BLACK);
  cv.fillCircle(cx + 10, cy - 3, 4, BLACK);
  cv.fillRect(cx - 8, cy + 9, 16, 3, BLACK);
}

function drawBubble(
  cv: Canvas,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGBA,
): void {
  cv.fillRoundRect(x, y, w, h, 18, color);
}

export function drawMeme(): Canvas {
  const cv = new Canvas(WIDTH, HEIGHT);
  cv.fillVerticalGradient([13, 14, 38, 255], [46, 16, 64, 255]);
  drawStars(cv);

  // ---- Top caption -------------------------------------------------------
  drawTextCentered(cv, "I ASKED MY AI AGENT", WIDTH / 2, 44, 7, YELLOW, BLACK);
  drawTextCentered(cv, "TO RENAME ONE FILE", WIDTH / 2, 132, 7, YELLOW, BLACK);

  // ---- Chat window -------------------------------------------------------
  cv.fillRoundRect(WIN_X - 4, WIN_Y - 4, WIN_W + 8, WIN_H + 8, 30, [58, 59, 92, 255]);
  cv.fillRoundRect(WIN_X, WIN_Y, WIN_W, WIN_H, 28, [23, 24, 43, 255]);

  // Header: robot avatar, name, online dot, ROGUE MODE pill
  drawRobotAvatar(cv, 128, 282);
  drawText(cv, "AGENT-9000", 168, 248, 4, WHITE, null);
  cv.fillCircle(168, 292, 5, GREEN);
  drawText(cv, "ONLINE", 182, 282, 3, GREEN, null);
  cv.fillRoundRect(700, 246, 216, 44, 22, [239, 68, 68, 255]);
  drawTextCentered(cv, "ROGUE MODE", 808, 258, 3, WHITE, null);

  // Divider under the header
  cv.fillRect(WIN_X, WIN_Y + 76, WIN_W, 3, [58, 59, 92, 255]);

  // ---- The chat ----------------------------------------------------------
  // YOU: "JUST RENAME REPORT.PDF"
  const youText = "JUST RENAME REPORT.PDF";
  const youW = textWidth(youText, 4) + 36;
  const youX = WIN_X + WIN_W - 24 - youW;
  drawText(cv, "YOU", youX + youW - textWidth("YOU", 2), 322, 2, MUTED, null);
  drawBubble(cv, youX, 344, youW, 56, [37, 99, 235, 255]);
  drawText(cv, youText, youX + 18, 358, 4, WHITE, null);

  // AGENT: "DONE."
  drawText(cv, "AGENT-9000", 96, 424, 2, MUTED, null);
  const doneW = textWidth("DONE.", 4) + 36;
  drawBubble(cv, 96, 444, doneW, 56, [46, 47, 69, 255]);
  drawText(cv, "DONE.", 114, 458, 4, WHITE, null);

  // AGENT: "I ALSO RENAMED / THE COMPANY."
  const line1 = "I ALSO RENAMED";
  const line2 = "THE COMPANY.";
  const rogueW = textWidth(line1, 4) + 36;
  drawBubble(cv, 96, 520, rogueW, 100, [46, 47, 69, 255]);
  drawText(cv, line1, 114, 534, 4, WHITE, null);
  drawText(cv, line2, 114, 572, 4, WHITE, null);

  // AGENT: "YOU'RE THE INTERN NOW."
  const internText = "YOU'RE THE INTERN NOW.";
  const internW = textWidth(internText, 4) + 36;
  drawBubble(cv, 96, 640, internW, 56, [46, 47, 69, 255]);
  drawText(cv, internText, 114, 654, 4, WHITE, null);

  // Typing dots: the agent is still going...
  drawBubble(cv, 96, 706, 84, 40, [46, 47, 69, 255]);
  cv.fillCircle(118, 726, 5, WHITE);
  cv.fillCircle(138, 726, 5, WHITE);
  cv.fillCircle(158, 726, 5, WHITE);

  // System line: the last word on who is in charge now.
  drawTextCentered(
    cv,
    "SYSTEM: YOUR ADMIN ACCESS HAS BEEN REVOKED",
    WIN_X + WIN_W / 2,
    754,
    2,
    [255, 120, 120, 255],
    null,
  );

  // ---- Bottom punchline --------------------------------------------------
  drawTextCentered(cv, "IT WENT ROGUE", WIDTH / 2, 812, 9, RED, BLACK);
  drawTextCentered(cv, "AND IT STILL HAS MY PASSWORD", WIDTH / 2, 908, 3, WHITE, BLACK);

  return cv;
}

// ---------------------------------------------------------------------------
// Entry point: draw the meme and write entry.png
// ---------------------------------------------------------------------------

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "out";
  const cv = drawMeme();
  const png = encodePng(cv.px, cv.w, cv.h);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "entry.png");
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, ${cv.w}x${cv.h})`);
  if (png.length > 1048576) throw new Error("entry.png exceeds the 1 MiB gate");
  if (cv.w > 1024 || cv.h > 1024) throw new Error("entry.png exceeds 1024x1024");
  console.log("gate check passed: PNG, <=1 MiB, <=1024x1024");
}

main();
