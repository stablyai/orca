// src/renderer/src/lib/lsp/lsp-navigation-providers.ts
import type * as Monaco from 'monaco-editor'
import {
  isLspRange,
  toHoverContents,
  toLspLocations,
  toLspPosition,
  toMonacoRange
} from './lsp-conversions'
import type { LspDocumentSync } from './lsp-document-sync'
import { LSP_LANGUAGE_IDS } from './lsp-document-sync'
import { resolveLocationModels } from './lsp-location-models'
import { createTypeScriptWorkerFallback } from './lsp-typescript-worker-fallback'

const readFile = (filePath: string) => window.api.fs.readFile({ filePath })

export function registerLspNavigationProviders(
  monaco: typeof Monaco,
  sync: LspDocumentSync
): Monaco.IDisposable[] {
  const languages = [...LSP_LANGUAGE_IDS]
  // Why: the worker's own providers stay off, so un-owned TS/JS models navigate through it here.
  const worker = createTypeScriptWorkerFallback(monaco)
  const locationsFor = async (
    model: Monaco.editor.ITextModel,
    method: string,
    extra: object,
    fallback: () => Promise<Monaco.languages.Location[] | null>
  ) => {
    const client = await sync.clientFor(model)
    if (!client) {
      return fallback()
    }
    const params = { textDocument: { uri: model.uri.toString() }, ...extra }
    const result = await client.request(method, params).catch(() => null)
    return resolveLocationModels<Monaco.Uri>(monaco, toLspLocations(result), readFile)
  }
  return [
    monaco.languages.registerDefinitionProvider(languages, {
      provideDefinition: (model, position) =>
        locationsFor(model, 'textDocument/definition', { position: toLspPosition(position) }, () =>
          worker.definition(model, position)
        )
    }),
    monaco.languages.registerReferenceProvider(languages, {
      provideReferences: (model, position) =>
        locationsFor(
          model,
          'textDocument/references',
          { position: toLspPosition(position), context: { includeDeclaration: true } },
          () => worker.references(model, position)
        )
    }),
    monaco.languages.registerHoverProvider(languages, {
      provideHover: async (model, position) => {
        const client = await sync.clientFor(model)
        if (!client) {
          return worker.hover(model, position)
        }
        const result = await client
          .request('textDocument/hover', {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position)
          })
          .catch(() => null)
        if (typeof result !== 'object' || result === null || !('contents' in result)) {
          return null
        }
        const contents = toHoverContents(result.contents)
        const range =
          'range' in result && isLspRange(result.range) ? toMonacoRange(result.range) : undefined
        return contents.length > 0 ? { contents, range } : null
      }
    })
  ]
}
