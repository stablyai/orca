// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { DiffsHighlighter, HighlightedToken } from '@pierre/diffs'
import { TextDocument } from '@pierre/diffs/edit'
import type { PluginGrammarWorker } from '@/lib/monaco-languages/plugin-grammar-worker-client'
import { PierrePluginTokenizer } from './pierre-plugin-tokenizer'

const disposables: PierrePluginTokenizer[] = []
afterEach(() => {
  disposables.splice(0).forEach((tokenizer) => tokenizer.dispose())
})

function setup() {
  const document = new TextDocument('file.custom', 'hello world', 'custom')
  const onDeferTokenize = vi.fn<(lines: Map<number, HighlightedToken[]>) => void>()
  const messages: { type: string; id?: number }[] = []
  let notifyInit: () => void = () => {}
  const initialized = new Promise<void>((resolve) => {
    notifyInit = resolve
  })
  let notifyJob: (id: number) => void = () => {}
  const nextJob = (): Promise<number> =>
    new Promise((resolve) => {
      notifyJob = resolve
    })
  let notifyPaint: () => void = () => {}
  const painted = new Promise<void>((resolve) => {
    notifyPaint = resolve
  })
  onDeferTokenize.mockImplementation(() => notifyPaint())
  const worker: PluginGrammarWorker = {
    postMessage: (message) => {
      messages.push(message)
      if (message.type === 'init') {
        notifyInit()
      }
      if (message.type === 'tokenize') {
        notifyJob(message.id)
      }
    },
    terminate: vi.fn(),
    onerror: null,
    onmessage: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The adapter reads only this theme; no local tokenization is available.
  const highlighter = {
    getTheme: () => ({
      fg: '#aaaaaa',
      textmate: { tokenColors: [{ scope: 'keyword', settings: { foreground: '#123456' } }] }
    })
  } as unknown as DiffsHighlighter
  const tokenizer = new PierrePluginTokenizer(
    { textDocument: document, theme: 'test', onDeferTokenize },
    highlighter,
    async () => ({
      id: 'plugin:custom',
      revision: '1',
      scopeName: 'source.custom',
      grammars: [],
      configuration: {}
    }),
    () => worker,
    vi.fn()
  )
  disposables.push(tokenizer)
  const respond = (data: unknown): void => worker.onmessage?.(new MessageEvent('message', { data }))
  const ready = async (): Promise<void> => {
    await initialized
    respond({ type: 'ready', ok: true })
  }
  return { document, tokenizer, worker, nextJob, painted, ready, respond, onDeferTokenize }
}

it('paints deferred plugin tokens and drops an answer superseded by an edit', async () => {
  const { document, tokenizer, nextJob, painted, ready, respond, onDeferTokenize } = setup()
  const firstJob = nextJob()
  tokenizer.prebuildStateStack()
  await ready()
  const first = await firstJob
  const change = document.applyEdits([
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'new' }
  ])!
  const secondJob = nextJob()
  expect(tokenizer.tokenize(change)).toEqual(new Map([[0, [[0, '', 'new world']]]]))
  respond({ type: 'complete', id: first, lines: 1, data: new Uint32Array([0, 0, 5, 5]) })
  const second = await secondJob
  respond({ type: 'complete', id: second, lines: 1, data: new Uint32Array([0, 0, 3, 5]) })
  await painted
  expect(onDeferTokenize.mock.calls).toEqual([
    [
      new Map([
        [
          0,
          [
            [0, '#123456', 'new'],
            [3, '#aaaaaa', ' world']
          ]
        ]
      ])
    ]
  ])
})

it('keeps editing after the grammar worker crashes', async () => {
  const { document, tokenizer, ready, worker, onDeferTokenize } = setup()
  tokenizer.prebuildStateStack()
  await ready()
  worker.onerror?.(new ErrorEvent('error'))
  await Promise.resolve()
  expect(worker.terminate).toHaveBeenCalled()
  expect(onDeferTokenize.mock.calls).toEqual([[new Map([[0, [[0, '', 'hello world']]]])]])
  const change = document.applyEdits([
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      newText: 'still editing'
    }
  ])!
  expect(tokenizer.tokenize(change)).toEqual(new Map([[0, [[0, '', 'still editing world']]]]))
})
