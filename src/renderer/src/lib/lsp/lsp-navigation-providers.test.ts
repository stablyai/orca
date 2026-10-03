import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { LspDocumentSync } from './lsp-document-sync'
import { registerLspNavigationProviders } from './lsp-navigation-providers'

type Provider = Record<string, (...args: unknown[]) => Promise<unknown>>

function textModel(uri: string, languageId = 'typescript') {
  return {
    uri: { toString: () => uri, scheme: 'file', path: uri.slice(7), fsPath: uri.slice(7) },
    getLanguageId: () => languageId,
    getOffsetAt: ({ column }: { column: number }) => column - 1,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    isDisposed: () => false
  }
}

function setup(client: { request: ReturnType<typeof vi.fn> } | null) {
  const target = textModel('file:///repo/b.ts')
  const worker = {
    getQuickInfoAtPosition: vi.fn().mockResolvedValue({
      displayParts: [{ text: 'const ' }, { text: 'a: number' }],
      documentation: [{ text: 'Docs' }],
      textSpan: { start: 6, length: 1 }
    }),
    getDefinitionAtPosition: vi.fn().mockResolvedValue([
      { fileName: 'file:///repo/b.ts', textSpan: { start: 2, length: 3 } },
      { fileName: 'file:///repo/missing.ts', textSpan: { start: 0, length: 1 } }
    ]),
    getReferencesAtPosition: vi.fn().mockResolvedValue([])
  }
  const providers: Record<string, Provider> = {}
  const register = (name: string) => (_languages: unknown, provider: Provider) => {
    providers[name] = provider
    return { dispose: () => {} }
  }
  const monaco = {
    languages: {
      registerDefinitionProvider: register('definition'),
      registerReferenceProvider: register('references'),
      registerHoverProvider: register('hover')
    },
    typescript: {
      getTypeScriptWorker: async () => async () => worker,
      getJavaScriptWorker: async () => async () => worker
    },
    editor: {
      getModel: (uri: { toString(): string }) =>
        uri.toString() === 'file:///repo/b.ts' ? target : null
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) }
  }
  const sync = { clientFor: vi.fn().mockResolvedValue(client) }
  registerLspNavigationProviders(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the providers only touch the members faked above.
    monaco as unknown as typeof Monaco,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the providers only call clientFor.
    sync as unknown as LspDocumentSync
  )
  return { providers, worker, target }
}

describe('registerLspNavigationProviders worker fallback', () => {
  const position = { lineNumber: 1, column: 7 }

  it('uses the TS worker for hover and definition when no LSP client owns the model', async () => {
    const { providers, worker, target } = setup(null)
    const model = textModel('file:///repo/a.ts')
    const hover = await providers.hover.provideHover(model, position)
    expect(worker.getQuickInfoAtPosition).toHaveBeenCalledWith('file:///repo/a.ts', 6)
    expect(hover).toEqual({
      range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 },
      contents: [{ value: '```typescript\nconst a: number\n```\n' }, { value: 'Docs' }]
    })
    const definition = await providers.definition.provideDefinition(model, position)
    expect(definition).toEqual([
      {
        uri: target.uri,
        range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 }
      }
    ])
  })

  it('never calls the worker when an LSP client owns the model', async () => {
    const client = { request: vi.fn().mockResolvedValue(null) }
    const { providers, worker } = setup(client)
    const model = textModel('file:///repo/a.ts')
    await providers.hover.provideHover(model, position)
    await providers.definition.provideDefinition(model, position)
    await providers.references.provideReferences(model, position, {})
    expect(client.request).toHaveBeenCalledTimes(3)
    expect(worker.getQuickInfoAtPosition).not.toHaveBeenCalled()
    expect(worker.getDefinitionAtPosition).not.toHaveBeenCalled()
    expect(worker.getReferencesAtPosition).not.toHaveBeenCalled()
  })

  it('returns nothing for a non-TS model without a client', async () => {
    const { providers, worker } = setup(null)
    expect(
      await providers.hover.provideHover(textModel('file:///repo/a.rb', 'ruby'), position)
    ).toBeNull()
    expect(worker.getQuickInfoAtPosition).not.toHaveBeenCalled()
  })
})
