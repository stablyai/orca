import { INITIAL, Registry, type IGrammar, type IOnigLib, type IRawGrammar } from 'shiki/textmate'
import type { PluginGrammarArtifact } from '../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import type { Oniguruma } from '../syntax-highlighting/oniguruma'
import { tokenizeLineWithinLimits } from '../syntax-highlighting/textmate-core'
import {
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT,
  PLUGIN_GRAMMAR_SLICE_MS,
  type PluginGrammarTokens
} from './plugin-grammar-protocol'
import { pluginSyntaxTokenType } from './plugin-syntax-token-legend'

export function onigLibrary(oniguruma: Oniguruma): IOnigLib {
  return {
    createOnigScanner: (sources) =>
      new oniguruma.OnigScanner(
        sources.map((source) => (typeof source === 'string' ? source : source.source))
      ),
    createOnigString: (text) => new oniguruma.OnigString(text)
  }
}

/** Compiles a language's grammar once. An include naming a scope outside the plugin resolves to
 *  nothing, so that region stays plain instead of the grammar failing. Null when it can't load. */
export function compilePluginGrammar(
  scopeName: string,
  grammars: readonly PluginGrammarArtifact[],
  onigLib: IOnigLib
): { grammar: IGrammar; dispose: () => void } | null {
  const byScope = new Map(grammars.map((grammar) => [grammar.scopeName, grammar]))
  const registry = new Registry({
    onigLib,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main validated each grammar's shape, and TextMate fills in the $self/$base entries IRawGrammar's type requires.
    loadGrammar: (scope) => (byScope.get(scope) as IRawGrammar | undefined) ?? null
  })
  try {
    const grammar = registry.loadGrammar(scopeName)
    if (grammar) {
      return { grammar, dispose: () => registry.dispose() }
    }
  } catch {
    // Why: TextMate throws when the root scope has no grammar; that is "unavailable".
  }
  registry.dispose()
  return null
}

/**
 * Tokenizes a whole document under core's per-line limits, yielding between slices so the worker
 * can report progress and see a cancellation. A line that is too long or keeps timing out ends the
 * pass; from there the file stays plain, as with Orca's own grammars. Null when cancelled or too big.
 */
export async function tokenizePluginGrammarDocument(
  grammar: IGrammar,
  text: string,
  options: {
    progress: () => void
    cancelled: () => boolean
    yieldSlice?: () => Promise<void>
  }
): Promise<PluginGrammarTokens | null> {
  const lines = text.split(/\r\n|\r|\n/)
  if (
    options.cancelled() ||
    text.length > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT ||
    lines.length > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
  ) {
    return null
  }
  const yieldSlice = options.yieldSlice ?? (() => new Promise((resolve) => setTimeout(resolve, 0)))
  const data: number[] = []
  let state = INITIAL
  let sliceStart = performance.now()
  let line = 0
  for (; line < lines.length; line += 1) {
    const value = lines[line] ?? ''
    const result = tokenizeLineWithinLimits(value, (input, timeLimitMs) =>
      grammar.tokenizeLine(input, state, timeLimitMs)
    )
    if (!result) {
      break
    }
    state = result.ruleStack
    let previousEnd = 0
    for (const token of result.tokens) {
      const start = Math.max(token.startIndex, previousEnd)
      const end = Math.min(token.endIndex, value.length)
      const type = pluginSyntaxTokenType(token.scopes)
      if (end <= start || type === null) {
        continue
      }
      previousEnd = end
      const last = data.length - 4
      const lastStart = data[last + 1] ?? -1
      const lastLength = data[last + 2] ?? 0
      // Why merge: a styled run split across scopes (a comment's marker and body) is one token.
      if (data[last] === line && data[last + 3] === type && lastStart + lastLength === start) {
        data[last + 2] = end - lastStart
      } else {
        data.push(line, start, end - start, type)
      }
    }
    if (performance.now() - sliceStart >= PLUGIN_GRAMMAR_SLICE_MS) {
      options.progress()
      await yieldSlice()
      if (options.cancelled()) {
        return null
      }
      sliceStart = performance.now()
    }
  }
  return { lines: line, data: new Uint32Array(data) }
}
