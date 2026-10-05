import type * as Monaco from 'monaco-editor'
import {
  isSemanticTokensLegend,
  LSP_SEMANTIC_TOKEN_MODIFIERS,
  LSP_SEMANTIC_TOKEN_TYPES,
  type SemanticTokensLegend
} from '../../../../shared/lsp-semantic-token-legend'
import { THEMED_SEMANTIC_TOKEN_TYPES } from '../monaco-orca-themes'
import type { LspDocumentSync } from './lsp-document-sync'

const SEMANTIC_TOKEN_LANGUAGE = 'ruby'
const CANONICAL_LEGEND: SemanticTokensLegend = {
  tokenTypes: LSP_SEMANTIC_TOKEN_TYPES,
  tokenModifiers: LSP_SEMANTIC_TOKEN_MODIFIERS
}

function remapModifiers(bits: number, modifierMap: readonly number[]): number {
  let remapped = 0
  modifierMap.forEach((target, source) => {
    if (target >= 0 && bits & (1 << source)) {
      remapped |= 1 << target
    }
  })
  return remapped >>> 0
}

// Why: themes key on canonical type names, so every server legend is rewritten onto one fixed legend.
export function remapSemanticTokens(
  data: readonly number[],
  server: SemanticTokensLegend,
  canonical: SemanticTokensLegend = CANONICAL_LEGEND,
  themedTypes: readonly string[] = THEMED_SEMANTIC_TOKEN_TYPES
): Uint32Array {
  const typeMap = server.tokenTypes.map((type) =>
    themedTypes.includes(type) ? canonical.tokenTypes.indexOf(type) : -1
  )
  const modifierMap = server.tokenModifiers.map((mod) => canonical.tokenModifiers.indexOf(mod))
  const out: number[] = []
  let line = 0
  let start = 0
  let keptLine = 0
  let keptStart = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]
    line += deltaLine
    start = deltaLine === 0 ? start + data[i + 1] : data[i + 1]
    const type = typeMap[data[i + 3]] ?? -1
    if (type < 0) {
      continue
    }
    const outDeltaLine = line - keptLine
    out.push(
      outDeltaLine,
      outDeltaLine === 0 ? start - keptStart : start,
      data[i + 2],
      type,
      remapModifiers(data[i + 4], modifierMap)
    )
    keptLine = line
    keptStart = start
  }
  return new Uint32Array(out)
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
}

export function registerLspSemanticTokensProvider(
  monaco: typeof Monaco,
  sync: LspDocumentSync
): Monaco.IDisposable {
  const legends = new WeakMap<object, SemanticTokensLegend | null>()
  const legendFor = async (client: {
    request(method: string, params: unknown): Promise<unknown>
  }) => {
    if (!legends.has(client)) {
      const legend = await client.request('orca/semanticTokensLegend', null)
      legends.set(client, isSemanticTokensLegend(legend) ? legend : null)
    }
    return legends.get(client) ?? null
  }
  return monaco.languages.registerDocumentSemanticTokensProvider(SEMANTIC_TOKEN_LANGUAGE, {
    // Why: a model opened while the server starts gets no tokens until it is re-queried.
    onDidChange: (listener) =>
      sync.onDocumentOpened((model) => {
        if (model.getLanguageId() === SEMANTIC_TOKEN_LANGUAGE) {
          listener()
        }
      }),
    getLegend: () => CANONICAL_LEGEND,
    provideDocumentSemanticTokens: async (model) => {
      try {
        const client = await sync.clientFor(model)
        const legend = client ? await legendFor(client) : null
        if (!client || !legend) {
          return null
        }
        const result = await client.request('textDocument/semanticTokens/full', {
          textDocument: { uri: model.uri.toString() }
        })
        if (typeof result !== 'object' || result === null || !('data' in result)) {
          return null
        }
        if (!isNumberArray(result.data)) {
          return null
        }
        const resultId =
          'resultId' in result && typeof result.resultId === 'string' ? result.resultId : undefined
        return { data: remapSemanticTokens(result.data, legend), resultId }
      } catch {
        return null
      }
    },
    releaseDocumentSemanticTokens: () => {}
  })
}
