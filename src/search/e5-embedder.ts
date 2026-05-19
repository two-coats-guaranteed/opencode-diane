/**
 * e5-embedder.ts — the real multilingual embedder, backed by the
 * `intfloat/e5` family via transformers.js (ONNX).
 *
 * This file is the ONLY place that touches the model runtime, and it
 * is imported dynamically — and only when `enableSemanticSearch` is
 * on. `@huggingface/transformers` is an OPTIONAL peer dependency: it is
 * not installed by a default `bun install`, so a user who never
 * enables semantic search never downloads it. The import specifier is
 * deliberately indirected through a `string`-typed constant so the
 * TypeScript build does not require the package to be present.
 *
 * `createE5Embedder` throws if the runtime or the model cannot be
 * loaded (package missing, network blocked, etc.); the caller is
 * expected to catch that, log it, and fall back to lexical-only
 * search — enabling the flag must never break the plugin.
 *
 * e5 is asymmetric: a query and the passage it should match take
 * different prefixes ("query: " / "passage: "). Getting that wrong
 * quietly degrades retrieval, so it is baked into the two methods.
 */

import { DEFAULT_EMBEDDING_MODEL, type Embedder } from "./embedder.js"

/** Minimal shape of a transformers.js feature-extraction output. */
interface ExtractionTensor {
  data: Float32Array | number[]
  dims: number[]
}
type Extractor = (
  text: string | string[],
  opts: Record<string, unknown>
) => Promise<ExtractionTensor>
interface TransformersModule {
  pipeline: (task: string, model: string) => Promise<Extractor>
}

export { DEFAULT_EMBEDDING_MODEL }

/** Passages longer than this are truncated before embedding (e5 caps at 512 tokens anyway). */
const MAX_CHARS = 2000

/** Embed in batches of this many texts to bound peak memory. */
const BATCH = 32

class E5Embedder implements Embedder {
  readonly id: string
  private extract: Extractor

  constructor(id: string, extract: Extractor) {
    this.id = id
    this.extract = extract
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.run([`query: ${clip(text)}`])
    return v
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => `passage: ${clip(t)}`)
      out.push(...(await this.run(batch)))
      // Yield between batches so a large embedding pass never starves
      // the event loop.
      await new Promise((r) => setTimeout(r, 0))
    }
    return out
  }

  /** Run the model on a batch and split the flat output into per-text vectors. */
  private async run(texts: string[]): Promise<Float32Array[]> {
    const t = await this.extract(texts, { pooling: "mean", normalize: true })
    const flat = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data)
    const dim = t.dims[t.dims.length - 1]
    const vecs: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      vecs.push(flat.slice(i * dim, (i + 1) * dim))
    }
    return vecs
  }
}

/**
 * Build an e5 embedder. Loads the transformers.js runtime and the
 * model (downloaded and cached on first use). Throws — with an
 * actionable message — if the optional dependency is missing or the
 * model cannot be fetched.
 */
export async function createE5Embedder(
  modelId: string = DEFAULT_EMBEDDING_MODEL
): Promise<Embedder> {
  // Indirected through a `string`-typed constant: the TS build does
  // not try to resolve the optional dependency at compile time.
  const spec: string = "@huggingface/transformers"
  let mod: TransformersModule
  try {
    mod = (await import(spec)) as TransformersModule
  } catch {
    throw new Error(
      "semantic search needs the optional dependency '@huggingface/transformers' — " +
        "install it with `bun add @huggingface/transformers` (or `npm install @huggingface/transformers`)"
    )
  }
  let extract: Extractor
  try {
    extract = await mod.pipeline("feature-extraction", modelId)
  } catch (e) {
    throw new Error(
      `could not load embedding model '${modelId}': ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return new E5Embedder(modelId, extract)
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
}
