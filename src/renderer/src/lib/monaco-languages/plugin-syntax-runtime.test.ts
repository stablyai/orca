// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginSyntaxMetadata } from '../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import type { PluginGrammarWorkerMessage } from './plugin-grammar-protocol'

type TokensProvider = {
  provideDocumentSemanticTokens: (
    model: unknown,
    lastResultId: null,
    token: { onCancellationRequested: () => { dispose: () => void } }
  ) => Promise<unknown>
}

const providers: TokensProvider[] = []

vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => ({
  languages: {
    register: () => {},
    setLanguageConfiguration: () => ({ dispose: () => {} }),
    registerDocumentSemanticTokensProvider: (_languageId: string, provider: TokensProvider) => {
      providers.push(provider)
      return { dispose: () => {} }
    }
  },
  editor: { getModels: () => [] }
}))

class FakeWorker {
  static readonly all: FakeWorker[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: PluginGrammarWorkerMessage[] = []
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(message: PluginGrammarWorkerMessage): void {
    this.messages.push(message)
    if (message.type === 'init') {
      queueMicrotask(() => this.reply({ type: 'ready', ok: true }))
    }
  }
  terminate(): void {}
  reply(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  lastJob(): number {
    const job = this.messages.findLast((message) => message.type === 'tokenize')
    return job?.type === 'tokenize' ? job.id : -1
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function syntax(revision: string): PluginSyntaxMetadata {
  return {
    id: 'plugin:samples.demo/yaml',
    pluginKey: 'samples.demo',
    label: 'yaml',
    extensions: ['.yaml'],
    filenames: [],
    revision
  }
}

const model = {
  getValueLength: () => 2,
  getLineCount: () => 1,
  getLineLength: () => 2,
  getValue: () => 'ab'
}
const token = { onCancellationRequested: () => ({ dispose: () => {} }) }

beforeEach(() => {
  providers.length = 0
  FakeWorker.all.length = 0
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('Worker', FakeWorker)
  Object.assign(window, {
    api: {
      plugins: {
        loadSyntax: async (id: string) => ({
          id,
          revision: 'r',
          scopeName: 'source.demo',
          grammars: [{ scopeName: 'source.demo', patterns: [], repository: {} }],
          configuration: {}
        })
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('flags revision A when its grammar crashes and shows nothing once B tokenizes', async () => {
  const runtime = await import('./plugin-syntax-runtime')
  const failures = await import('@/store/plugin-syntax-failures')
  const packs = await import('@/store/plugin-syntax-packs')
  const a = syntax('a')
  const b = syntax('b')
  packs.usePluginSyntaxStore.setState({ entries: [a], loaded: true })

  expect(runtime.acquirePluginSyntaxLanguage(a)).not.toBeNull()
  const crashing = providers[0]?.provideDocumentSemanticTokens(model, null, token)
  await flush()
  FakeWorker.all[0]?.onerror?.(new ErrorEvent('error'))
  await crashing
  expect(failures.usePluginSyntaxFailureStore.getState().failures).toEqual({
    [failures.pluginSyntaxRevisionKey(a)]: 'crashed'
  })

  packs.usePluginSyntaxStore.setState({ entries: [b], loaded: true })
  expect(runtime.acquirePluginSyntaxLanguage(b)).not.toBeNull()
  const working = providers[1]?.provideDocumentSemanticTokens(model, null, token)
  await flush()
  const worker = FakeWorker.all[1]
  worker?.reply({
    id: worker.lastJob(),
    type: 'complete',
    lines: 1,
    data: new Uint32Array([0, 0, 2, 0])
  })

  await expect(working).resolves.toMatchObject({ data: expect.anything() })
  const state = failures.usePluginSyntaxFailureStore.getState()
  expect(state.failures).toEqual({})
})
