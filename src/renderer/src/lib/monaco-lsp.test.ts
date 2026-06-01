/* eslint-disable max-lines -- Why: this file exercises the Monaco LSP adapter's
provider registration, document lifecycle, diagnostics, and retry sequencing in
one module so module-level provider state can be reset consistently per test. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  LspCompletionResult,
  LspDiagnosticsEvent,
  LspDocumentChange,
  LspDocumentContext,
  LspDocumentIdentity,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../../../shared/lsp-types'

type CompletionProvider = {
  provideCompletionItems: (
    model: ModelMock,
    position: { lineNumber: number; column: number }
  ) => Promise<{ suggestions: Record<string, unknown>[] }>
}

type DefinitionProvider = {
  provideDefinition: (
    model: ModelMock,
    position: { lineNumber: number; column: number }
  ) => Promise<unknown[]>
}

type ModelMock = {
  uri: { toString: () => string }
  getValue: () => string
  getWordUntilPosition: () => { startColumn: number; endColumn: number }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < 1_000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

function installWindowApi(lsp: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    value: { api: { lsp } },
    configurable: true
  })
}

function createLspApi(
  overrides: Partial<{
    getStatus: (args: LspDocumentIdentity) => Promise<LspServerStatus>
    openDocument: (args: LspDocumentContext) => Promise<LspServerStatus>
    changeDocument: (args: LspDocumentChange) => Promise<void>
    closeDocument: (args: Omit<LspDocumentChange, 'content'>) => Promise<void>
    completion: (args: LspRequestContext) => Promise<LspCompletionResult | null>
    hover: (args: LspRequestContext) => Promise<LspHover | null>
    definition: (args: LspRequestContext) => Promise<LspLocation[]>
    getStats: () => Promise<{ activeSessions: number; sessions: Record<string, unknown>[] }>
    onDiagnostics: (callback: (event: LspDiagnosticsEvent) => void) => () => void
  }> = {}
) {
  const api = {
    getStatus: vi.fn(async (args: LspDocumentIdentity) => ({
      state: 'available' as const,
      languageId: args.languageId
    })),
    openDocument: vi.fn(async (args: LspDocumentContext) => ({
      state: 'available' as const,
      languageId: args.languageId
    })),
    changeDocument: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => undefined),
    completion: vi.fn(async () => null),
    hover: vi.fn(async () => null),
    definition: vi.fn(async () => []),
    getStats: vi.fn(async () => ({ activeSessions: 0, sessions: [] })),
    onDiagnostics: vi.fn((_callback: (event: LspDiagnosticsEvent) => void) => () => {})
  }
  return { ...api, ...overrides }
}

function createMonacoMock(
  modelUri = 'file:///tmp/project/main.c',
  content = 'struct Foo foo;'
): {
  monaco: never
  model: ModelMock
  completionProviders: Map<string, CompletionProvider>
  definitionProviders: Map<string, DefinitionProvider>
  addModel: (uri: string, modelContent?: string) => ModelMock
  setModelContent: (value: string) => void
} {
  let modelContent = content
  const createModel = (uri: string, getContent: () => string): ModelMock => ({
    uri: { toString: () => uri },
    getValue: vi.fn(getContent),
    getWordUntilPosition: () => ({ startColumn: 4, endColumn: 7 })
  })
  const model: ModelMock = {
    uri: { toString: () => modelUri },
    getValue: vi.fn(() => modelContent),
    getWordUntilPosition: () => ({ startColumn: 4, endColumn: 7 })
  }
  const models = new Map([[modelUri, model]])
  const completionProviders = new Map<string, CompletionProvider>()
  const definitionProviders = new Map<string, DefinitionProvider>()
  class Range {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number
    ) {}
  }
  const monaco = {
    Range,
    Uri: {
      parse: (value: string) => ({ toString: () => value })
    },
    MarkerSeverity: {
      Error: 8,
      Warning: 4,
      Info: 2,
      Hint: 1
    },
    languages: {
      CompletionItemKind: {
        Text: 1,
        Method: 2,
        Function: 3,
        Constructor: 4,
        Field: 5,
        Variable: 6,
        Class: 7,
        Interface: 8,
        Module: 9,
        Property: 10,
        Unit: 11,
        Value: 12,
        Enum: 13,
        Keyword: 14,
        Snippet: 15,
        Color: 16,
        File: 17,
        Reference: 18,
        Folder: 19,
        EnumMember: 20,
        Constant: 21,
        Struct: 22,
        Event: 23,
        Operator: 24,
        TypeParameter: 25
      },
      CompletionItemInsertTextRule: {
        InsertAsSnippet: 4
      },
      registerCompletionItemProvider: vi.fn((language: string, provider: CompletionProvider) => {
        completionProviders.set(language, provider)
        return { dispose: vi.fn() }
      }),
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerDefinitionProvider: vi.fn((language: string, provider: DefinitionProvider) => {
        definitionProviders.set(language, provider)
        return { dispose: vi.fn() }
      })
    },
    editor: {
      getModel: vi.fn((uri: { toString: () => string }) => models.get(uri.toString()) ?? null),
      setModelMarkers: vi.fn()
    }
  }
  return {
    monaco: monaco as never,
    model,
    completionProviders,
    definitionProviders,
    addModel: (uri, value = content) => {
      let addedModelContent = value
      const addedModel = createModel(uri, () => addedModelContent)
      models.set(uri, addedModel)
      return addedModel
    },
    setModelContent: (value: string) => {
      modelContent = value
    }
  }
}

function documentArgs(
  content = 'struct Foo foo;',
  overrides: Partial<LspDocumentContext & { modelUri: string }> = {}
): LspDocumentContext & { modelUri: string } {
  return {
    modelUri: 'file:///tmp/project/main.c',
    worktreeId: 'repo::/tmp/project',
    worktreePath: '/tmp/project',
    filePath: '/tmp/project/main.c',
    languageId: 'c',
    content,
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'window')
})

describe('monaco-lsp', () => {
  it('keeps the LSP document open while split panes share the same Monaco model', async () => {
    vi.resetModules()
    const api = createLspApi()
    installWindowApi(api)
    const { monaco } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const disposeFirst = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    const disposeSecond = registerMonacoLspDocument(monaco, documentArgs())

    disposeSecond()
    expect(api.closeDocument).not.toHaveBeenCalled()

    disposeFirst()
    await waitForAssertion(() => expect(api.closeDocument).toHaveBeenCalledTimes(1))
  })

  it('does not register external providers for Monaco-owned TypeScript languages', async () => {
    vi.resetModules()
    const api = createLspApi()
    installWindowApi(api)
    const { monaco, completionProviders } = createMonacoMock()
    const { ensureMonacoLspProviders } = await import('./monaco-lsp')

    ensureMonacoLspProviders(monaco)

    expect(completionProviders.has('typescript')).toBe(false)
    expect(completionProviders.has('javascript')).toBe(false)
  })

  it('does not start external LSP sessions for Monaco-owned TypeScript languages', async () => {
    vi.resetModules()
    const api = createLspApi()
    installWindowApi(api)
    const { monaco } = createMonacoMock('file:///tmp/project/main.ts', 'const x = 1')
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(
      monaco,
      documentArgs('const x = 1', {
        modelUri: 'file:///tmp/project/main.ts',
        filePath: '/tmp/project/main.ts',
        languageId: 'typescript'
      })
    )

    expect(api.getStatus).not.toHaveBeenCalled()
    expect(api.openDocument).not.toHaveBeenCalled()
    dispose()
  })

  it('checks LSP status without sending full document content', async () => {
    vi.resetModules()
    const api = createLspApi()
    installWindowApi(api)
    const { monaco } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs('large content'))
    await waitForAssertion(() => expect(api.getStatus).toHaveBeenCalledTimes(1))

    expect(api.getStatus).toHaveBeenCalledWith(
      expect.not.objectContaining({ content: 'large content' })
    )
    dispose()
  })

  it('closes a document that finishes opening after its editor unmounts', async () => {
    vi.resetModules()
    const openDeferred = deferred<LspServerStatus>()
    const api = createLspApi({
      openDocument: vi.fn((args: LspDocumentContext) => {
        return openDeferred.promise.then(() => ({
          state: 'available' as const,
          languageId: args.languageId
        }))
      })
    })
    installWindowApi(api)
    const { monaco } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))

    dispose()
    expect(api.closeDocument).not.toHaveBeenCalled()
    openDeferred.resolve({ state: 'available', languageId: 'c' })

    await waitForAssertion(() => expect(api.closeDocument).toHaveBeenCalledTimes(1))
  })

  it('flushes edits that arrive while the initial open is still pending', async () => {
    vi.resetModules()
    const openDeferred = deferred<LspServerStatus>()
    const api = createLspApi({
      openDocument: vi.fn((args: LspDocumentContext) => {
        return openDeferred.promise.then(() => ({
          state: 'available' as const,
          languageId: args.languageId
        }))
      })
    })
    installWindowApi(api)
    const { monaco, model } = createMonacoMock()
    const { registerMonacoLspDocument, updateMonacoLspDocumentContent } =
      await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs('before'))
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))

    updateMonacoLspDocumentContent(model.uri.toString(), 'after')
    openDeferred.resolve({ state: 'available', languageId: 'c' })

    await waitForAssertion(() =>
      expect(api.changeDocument).toHaveBeenCalledWith(expect.objectContaining({ content: 'after' }))
    )
    expect(api.openDocument).toHaveBeenCalledWith(expect.objectContaining({ content: 'before' }))

    dispose()
  })

  it('serializes document changes so older IPC writes cannot overtake newer text', async () => {
    vi.resetModules()
    const firstChange = deferred<void>()
    const sentContents: string[] = []
    const api = createLspApi({
      changeDocument: vi.fn((args: LspDocumentChange) => {
        sentContents.push(args.content)
        return sentContents.length === 1 ? firstChange.promise : Promise.resolve()
      })
    })
    installWindowApi(api)
    const { monaco, model } = createMonacoMock()
    const { registerMonacoLspDocument, updateMonacoLspDocumentContent } =
      await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs('initial'))
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()

    updateMonacoLspDocumentContent(model.uri.toString(), 'first')
    await vi.advanceTimersByTimeAsync(251)
    expect(api.changeDocument).toHaveBeenCalledTimes(1)

    updateMonacoLspDocumentContent(model.uri.toString(), 'second')
    await vi.advanceTimersByTimeAsync(251)
    expect(api.changeDocument).toHaveBeenCalledTimes(1)

    firstChange.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(api.changeDocument).toHaveBeenCalledTimes(2)
    expect(sentContents).toEqual(['first', 'second'])

    dispose()
  })

  it('waits for an in-flight document change before closing on unmount', async () => {
    vi.resetModules()
    const change = deferred<void>()
    const api = createLspApi({
      changeDocument: vi.fn(() => change.promise)
    })
    installWindowApi(api)
    const { monaco, model } = createMonacoMock()
    const { registerMonacoLspDocument, updateMonacoLspDocumentContent } =
      await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs('initial'))
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()

    updateMonacoLspDocumentContent(model.uri.toString(), 'edited')
    await vi.advanceTimersByTimeAsync(251)
    expect(api.changeDocument).toHaveBeenCalledTimes(1)

    dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.closeDocument).not.toHaveBeenCalled()

    change.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(api.closeDocument).toHaveBeenCalledTimes(1)
  })

  it('closes the old document id when the same model remounts quickly', async () => {
    vi.resetModules()
    const api = createLspApi()
    installWindowApi(api)
    const { monaco } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const disposeFirst = registerMonacoLspDocument(monaco, documentArgs('first'))
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    const openDocumentMock = vi.mocked(api.openDocument)
    const firstDocumentId = openDocumentMock.mock.calls[0][0].documentId

    disposeFirst()
    const disposeSecond = registerMonacoLspDocument(monaco, documentArgs('second'))
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(2))
    const secondDocumentId = openDocumentMock.mock.calls[1][0].documentId

    expect(secondDocumentId).not.toBe(firstDocumentId)
    await waitForAssertion(() =>
      expect(api.closeDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: firstDocumentId })
      )
    )

    disposeSecond()
  })

  it('uses completion text edits without resending full document content per request', async () => {
    vi.resetModules()
    const api = createLspApi({
      completion: vi.fn(async () => ({
        isIncomplete: false,
        items: [
          {
            label: 'alpha',
            kind: 22,
            insertText: 'ignored',
            textEdit: {
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
              newText: 'alpha()'
            },
            additionalTextEdits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '#include <alpha.h>\n'
              }
            ]
          }
        ]
      }))
    })
    installWindowApi(api)
    const { monaco, model, completionProviders } = createMonacoMock()
    const { registerMonacoLspDocument, updateMonacoLspDocumentContent } =
      await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))

    const provider = completionProviders.get('c')
    if (!provider) {
      throw new Error('expected C completion provider to be registered')
    }
    updateMonacoLspDocumentContent(model.uri.toString(), 'struct Alpha alpha;')
    const result = await provider.provideCompletionItems(model, { lineNumber: 1, column: 7 })

    expect(model.getValue).not.toHaveBeenCalled()
    expect(api.changeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'struct Alpha alpha;' })
    )
    expect(api.completion).toHaveBeenCalledWith(
      expect.not.objectContaining({ content: expect.any(String) })
    )
    expect(result.suggestions[0]).toMatchObject({
      label: 'alpha',
      kind: 22,
      insertText: 'alpha()',
      range: {
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 5
      },
      additionalTextEdits: [
        {
          text: '#include <alpha.h>\n',
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1
          }
        }
      ]
    })

    dispose()
  })

  it('keeps diagnostics scoped to the matching runtime environment', async () => {
    vi.resetModules()
    let onDiagnostics: ((event: LspDiagnosticsEvent) => void) | null = null
    const api = createLspApi({
      onDiagnostics: vi.fn((callback: (event: LspDiagnosticsEvent) => void) => {
        onDiagnostics = callback
        return () => {}
      })
    })
    installWindowApi(api)
    const { monaco, addModel } = createMonacoMock('file:///runtime-a/main.c')
    const runtimeBModel = addModel('file:///runtime-b/main.c')
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const disposeA = registerMonacoLspDocument(
      monaco,
      documentArgs('int main(void);', {
        modelUri: 'file:///runtime-a/main.c',
        runtimeEnvironmentId: 'runtime-a'
      })
    )
    const disposeB = registerMonacoLspDocument(
      monaco,
      documentArgs('int main(void);', {
        modelUri: 'file:///runtime-b/main.c',
        runtimeEnvironmentId: 'runtime-b'
      })
    )
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(2))

    const emitDiagnostics = onDiagnostics as ((event: LspDiagnosticsEvent) => void) | null
    if (!emitDiagnostics) {
      throw new Error('expected diagnostics listener to be registered')
    }
    emitDiagnostics({
      worktreePath: '/tmp/project',
      filePath: '/tmp/project/main.c',
      languageId: 'c',
      runtimeEnvironmentId: 'runtime-b',
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: 'runtime-b diagnostic'
        }
      ]
    })

    const monacoMock = monaco as unknown as {
      editor: { setModelMarkers: ReturnType<typeof vi.fn> }
    }
    expect(monacoMock.editor.setModelMarkers).toHaveBeenCalledTimes(1)
    expect(monacoMock.editor.setModelMarkers).toHaveBeenCalledWith(
      runtimeBModel,
      'orca-lsp',
      expect.arrayContaining([expect.objectContaining({ message: 'runtime-b diagnostic' })])
    )

    disposeA()
    disposeB()
  })

  it('retries document activation after an initial unavailable status', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'))
    const api = createLspApi({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ state: 'unavailable', languageId: 'c', reason: 'reconnecting' })
        .mockResolvedValue({ state: 'available', languageId: 'c' }),
      completion: vi.fn(async () => [{ label: 'ready' }])
    })
    installWindowApi(api)
    const { monaco, model, completionProviders } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.getStatus).toHaveBeenCalledTimes(1))
    const provider = completionProviders.get('c')
    if (!provider) {
      throw new Error('expected C completion provider to be registered')
    }

    await expect(
      provider.provideCompletionItems(model, { lineNumber: 1, column: 7 })
    ).resolves.toEqual({ suggestions: [] })
    expect(api.openDocument).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_001)
    const result = await provider.provideCompletionItems(model, { lineNumber: 1, column: 7 })

    expect(api.getStatus).toHaveBeenCalledTimes(2)
    expect(api.openDocument).toHaveBeenCalledTimes(1)
    expect(api.completion).toHaveBeenCalledTimes(1)
    expect(result.suggestions[0]).toMatchObject({ label: 'ready' })

    dispose()
  })

  it('marks a document for status retry after an LSP request failure', async () => {
    vi.resetModules()
    const api = createLspApi({
      completion: vi
        .fn()
        .mockRejectedValueOnce(new Error('No active SSH connection for "ssh-1"'))
        .mockResolvedValue([{ label: 'ready' }])
    })
    installWindowApi(api)
    const { monaco, model, completionProviders } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(
      monaco,
      documentArgs('int main(void);', { connectionId: 'ssh-1' })
    )
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'))
    const provider = completionProviders.get('c')
    if (!provider) {
      throw new Error('expected C completion provider to be registered')
    }

    await expect(
      provider.provideCompletionItems(model, { lineNumber: 1, column: 7 })
    ).resolves.toEqual({ suggestions: [] })

    await vi.advanceTimersByTimeAsync(2_001)
    const result = await provider.provideCompletionItems(model, { lineNumber: 1, column: 7 })

    expect(api.getStatus).toHaveBeenCalledTimes(2)
    expect(api.openDocument).toHaveBeenCalledTimes(2)
    expect(result.suggestions[0]).toMatchObject({ label: 'ready' })

    dispose()
  })

  it('returns single definition targets to Monaco without opening files as a side effect', async () => {
    vi.resetModules()
    const api = createLspApi({
      definition: vi.fn(async () => [
        {
          uri: 'file:///tmp/project/include/foo.h',
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }
        }
      ])
    })
    installWindowApi(api)
    const { monaco, model, definitionProviders } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    const provider = definitionProviders.get('c')
    if (!provider) {
      throw new Error('expected C definition provider to be registered')
    }

    const definitions = await provider.provideDefinition(model, { lineNumber: 1, column: 7 })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({
      range: {
        startLineNumber: 5,
        startColumn: 3,
        endLineNumber: 5,
        endColumn: 6
      }
    })

    dispose()
  })

  it('returns multiple definition targets to Monaco instead of forcing the first one', async () => {
    vi.resetModules()
    const api = createLspApi({
      definition: vi.fn(async () => [
        {
          uri: 'file:///tmp/project/include/foo.h',
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }
        },
        {
          uri: 'file:///tmp/project/include/bar.h',
          range: { start: { line: 8, character: 1 }, end: { line: 8, character: 4 } }
        }
      ])
    })
    installWindowApi(api)
    const { monaco, model, definitionProviders } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    const provider = definitionProviders.get('c')
    if (!provider) {
      throw new Error('expected C definition provider to be registered')
    }

    const definitions = await provider.provideDefinition(model, { lineNumber: 1, column: 7 })

    expect(definitions).toHaveLength(2)
    expect(definitions[0]).toMatchObject({
      range: {
        startLineNumber: 5,
        startColumn: 3,
        endLineNumber: 5,
        endColumn: 6
      }
    })

    dispose()
  })
})
