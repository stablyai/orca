import type { PluginGrammarArtifact } from '../../../../shared/plugins/plugin-syntax-artifact'

// Why these bounds: every edit re-tokenizes the whole document, so big files stay plain.
export const PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT = 500_000
export const PLUGIN_GRAMMAR_MODEL_LINE_LIMIT = 20_000
/** The worker reports progress, and checks for cancellation, at least this often. */
export const PLUGIN_GRAMMAR_SLICE_MS = 100
/** No progress for this long means the engine is stuck; the worker is terminated. */
export const PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS = 2_000
export const PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS = 30_000

/** Sent once per worker; the worker compiles the grammar and keeps it for every document. */
export type PluginGrammarInit = {
  type: 'init'
  scopeName: string
  grammars: readonly PluginGrammarArtifact[]
}

export type PluginGrammarWorkerMessage =
  | PluginGrammarInit
  | { type: 'tokenize'; id: number; text: string }
  | { type: 'cancel'; id: number }

/** Worker setup (loading the regex engine and compiling the grammar) gets its own, longer
 *  deadline; the progress deadline starts with the first document. */
export const PLUGIN_GRAMMAR_INIT_DEADLINE_MS = 20_000

/** One token per quad: line, start column, length, index into the token legend. Lines from
 *  `lines` on stay plain because a line there was too long or too slow to tokenize. */
export type PluginGrammarTokens = {
  lines: number
  data: Uint32Array
}

export type PluginGrammarResponse =
  | { type: 'ready'; ok: boolean }
  | { id: number; type: 'progress' }
  | ({ id: number; type: 'complete' } & PluginGrammarTokens)
  | { id: number; type: 'unavailable' }

/** The renderer trusts nothing the worker returns: every quad must fit the document it sent. */
export function isValidPluginGrammarTokens(
  tokens: PluginGrammarTokens,
  lineLengths: readonly number[],
  legendSize: number
): boolean {
  if (
    !(tokens.data instanceof Uint32Array) ||
    tokens.data.length % 4 !== 0 ||
    tokens.lines > lineLengths.length
  ) {
    return false
  }
  let previousLine = -1
  let previousEnd = 0
  for (let offset = 0; offset < tokens.data.length; offset += 4) {
    const line = tokens.data[offset] ?? 0
    const start = tokens.data[offset + 1] ?? 0
    const length = tokens.data[offset + 2] ?? 0
    const type = tokens.data[offset + 3] ?? 0
    if (line !== previousLine) {
      previousEnd = 0
    }
    if (
      line < previousLine ||
      line >= tokens.lines ||
      length === 0 ||
      start < previousEnd ||
      start + length > (lineLengths[line] ?? 0) ||
      type >= legendSize
    ) {
      return false
    }
    previousLine = line
    previousEnd = start + length
  }
  return true
}
