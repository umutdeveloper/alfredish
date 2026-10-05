// SPEC §9.1: meaning similarity for K23 and `alfred keys`. A fixed embedding model ships inside alfredish and runs
// in-process (llama.cpp through node-llama-cpp): no network, no external application. It is loaded only when needed.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KeyDef } from "./types.ts";

export const MODEL_PATH = fileURLToPath(new URL("../models/nomic-embed-text-v1.5.Q4_K_M.gguf", import.meta.url));
export const MODEL_SHA256 = "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac";
/** K23: candidates at or above this must be decided in distinctFrom (measured; see SPEC K23). */
export const KEY_SIMILARITY_THRESHOLD = 0.7;

/** K29: events at or above this must be decided (measured on retold and conflicting events; see SPEC K29). */
export const EVENT_SIMILARITY_THRESHOLD = 0.78;

export type Embed = (text: string) => Promise<number[]>;

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

let loading: Promise<Embed> | undefined;

/** The pinned model, verified by hash. Rejects with a reason when it is missing, altered or cannot run. */
export function embedder(): Promise<Embed> {
  loading ??= (async () => {
    let digest: string;
    try {
      digest = await sha256(MODEL_PATH);
    } catch {
      throw new Error(`model file missing (${MODEL_PATH})`);
    }
    if (digest !== MODEL_SHA256) throw new Error("model file altered (sha256 does not match the pinned one)");
    const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
    const llama = await getLlama({ build: "never", logLevel: LlamaLogLevel.error });
    const model = await llama.loadModel({ modelPath: MODEL_PATH });
    const ctx = await model.createEmbeddingContext();
    const cache = new Map<string, number[]>();
    return async (text: string) => {
      let v = cache.get(text);
      if (!v) {
        v = Array.from((await ctx.getEmbeddingFor(text)).vector);
        cache.set(text, v);
      }
      return v;
    };
  })();
  return loading;
}

export const keyText = (k: Pick<KeyDef, "name" | "describe">) => `clustering: ${k.name} — ${k.describe}`;
export const eventText = (e: { title: string; text: string }) => `clustering: ${e.title}. ${e.text}`;

export function cosine(a: readonly number[], b: readonly number[]): number {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    x += a[i]! ** 2;
    y += b[i]! ** 2;
  }
  return d / Math.sqrt(x * y);
}

/** Keys ranked by meaning similarity to a text, most similar first. */
export async function rank(embed: Embed, text: string, keys: readonly KeyDef[]): Promise<{ key: KeyDef; score: number }[]> {
  const t = await embed(text);
  const out: { key: KeyDef; score: number }[] = [];
  for (const k of keys) out.push({ key: k, score: cosine(t, await embed(keyText(k))) });
  return out.sort((a, b) => b.score - a.score);
}
