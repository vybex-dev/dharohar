import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "@/lib/pipeline";

export function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic number in [0, 1) from a 64-char hex string. Stub data only. */
export function unitFromHex(hex: string, slot: number): number {
  const start = (slot * 8) % 56;
  const n = parseInt(hex.slice(start, start + 8), 16);
  return Number.isFinite(n) ? n / 0x100000000 : 0.5;
}

/** Deterministic, non-zero fake embedding. Replaced by real vectors in the AI phase. */
export function fakeEmbedding(seedHex: string): number[] {
  const seed = parseInt(seedHex.slice(0, 8), 16) % 10000;
  const out: number[] = [];
  for (let i = 1; i <= EMBEDDING_DIMENSIONS; i++) {
    out.push(Number(Math.sin(seed * 1000 + i).toFixed(6)));
  }
  return out;
}

/** EWKT for a geography point. Longitude first. */
export function pointEwkt(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`;
}
