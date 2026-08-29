import type { editor } from 'monaco-editor'

/**
 * Above ~20MB of text or ~300k lines the editor permanently drops tokenization,
 * folding, code lenses, sticky scroll, word highlighting and line wrapping for a
 * model — decided once at model construction and never revisited. Orca inherits
 * that silently, so the user sees features vanish with no explanation.
 *
 * The verdict is read from the model instead of recomputed from the byte length,
 * because the model's own thresholds are internal and can move between editor
 * versions; a recomputed guess would eventually describe a degradation that did
 * not happen (or miss one that did).
 */
export type MonacoLargeFileOptimizations = 'applied' | 'not-applied' | 'unknown'

type TokenizationSizeProbe = {
  isTooLargeForTokenization?: () => unknown
}

export function readMonacoLargeFileOptimizations(
  model: editor.ITextModel | null | undefined
): MonacoLargeFileOptimizations {
  const probe = (model as TokenizationSizeProbe | null | undefined)?.isTooLargeForTokenization
  if (typeof probe !== 'function') {
    // The flag is @internal in the public typings; not finding it means we do
    // not know, which is never the same as "optimizations are off".
    return 'unknown'
  }
  let verdict: unknown
  try {
    verdict = probe.call(model)
  } catch {
    return 'unknown'
  }
  if (typeof verdict !== 'boolean') {
    return 'unknown'
  }
  return verdict ? 'applied' : 'not-applied'
}
