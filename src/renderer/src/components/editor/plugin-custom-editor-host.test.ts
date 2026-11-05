import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_EDITOR_DOCUMENT_MAX_BYTES } from '../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import { createPanelMessageBudget } from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import { createPluginFrameMessageHandler } from '../plugins/frames/plugin-frame-host'
import { createCustomEditorHost } from './plugin-custom-editor-host'
import type { CustomEditorHostOptions } from './plugin-custom-editor-host-types'

vi.mock('../plugins/frames/plugin-panel-design-token-css', () => ({
  currentPluginFrameTheme: () => ({ colorScheme: 'light', tokens: '' })
}))

/** Drives the editor host through the frame host, exactly as the frame's `window.orca` would. */

const READY = { orca: 1, kind: 'evt', event: 'ready', payload: { protocol: 1 } }
let nextId = 100
const applyEdit = (content: unknown, baseVersion = 1, id = nextId++) => ({
  orca: 1,
  kind: 'req',
  id,
  method: 'editor.applyEdit',
  params: { baseVersion, content }
})
const edit = (text: string, baseVersion = 1, id?: number) =>
  applyEdit({ kind: 'text', text }, baseVersion, id)
const keydown = (payload: Record<string, unknown>) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.keydown',
  payload
})

type Posted = { message: unknown; transfer: unknown }

function harness(
  options: Omit<CustomEditorHostOptions, 'getFrameWindow' | 'onEdit'> & {
    onEdit?: CustomEditorHostOptions['onEdit']
  }
) {
  const posted: Posted[] = []
  const frameWindow = {
    postMessage: (message: unknown, _origin: string, transfer?: unknown) =>
      posted.push({ message, transfer })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hosts only call postMessage and compare identity.
  const getFrameWindow = () => frameWindow as unknown as Window
  const host = createCustomEditorHost({ onEdit: vi.fn(), ...options, getFrameWindow })
  const handler = createPluginFrameMessageHandler({
    surface: 'editor',
    getFrameWindow,
    getSessionToken: () => null,
    callHostMethod: vi.fn(),
    editor: host.channel
  })
  const send = (data: unknown, source: unknown = frameWindow) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only data and source.
    handler({ data, source } as unknown as MessageEvent)
  const messages = () => posted.map(({ message }) => message)
  const documents = () =>
    messages().filter(
      (message) => isPluginJsonObject(message) && message.event === 'editor.document'
    )
  const answers = (id: number) =>
    messages().filter(
      (message) => isPluginJsonObject(message) && message.kind === 'res' && message.id === id
    )
  const answerFlushes = () => {
    for (const message of messages()) {
      if (isPluginJsonObject(message) && message.method === 'editor.flush') {
        send({ orca: 1, kind: 'res', id: message.id, result: null })
      }
    }
  }
  return { host, posted, send, messages, documents, answers, answerFlushes }
}

function setupWith(initial: {
  text: string
  onMergesOutside: () => void
  onKeyChord?: CustomEditorHostOptions['onKeyChord']
}) {
  const doc = { text: initial.text, readOnly: false }
  const onEdit = vi.fn((text: string) => {
    doc.text = text
  })
  return {
    ...harness({
      getDocument: () => doc,
      onEdit,
      onMergesOutside: initial.onMergesOutside,
      flushTimeoutMs: 1_000,
      ...(initial.onKeyChord ? { onKeyChord: initial.onKeyChord } : {})
    }),
    onEdit
  }
}

function setup(initial: {
  text: string
  readOnly?: boolean
  maxEdits?: number
  now?: () => number
}) {
  const doc = { text: initial.text, readOnly: initial.readOnly ?? false }
  const onEdit = vi.fn((text: string) => {
    doc.text = text
  })
  const onEditRefused = vi.fn()
  const onKeyChord = vi.fn()
  const onUnappliedEdit = vi.fn()
  const h = harness({
    getDocument: () => doc,
    onEdit,
    onEditRefused,
    onUnappliedEdit,
    onKeyChord,
    flushTimeoutMs: 50,
    ...(initial.now ? { now: initial.now } : {}),
    ...(initial.maxEdits === undefined
      ? {}
      : {
          budget: createPanelMessageBudget({
            maxBytes: CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
            maxMessages: initial.maxEdits,
            perMs: 60_000
          })
        })
  })
  return { ...h, doc, onEdit, onEditRefused, onUnappliedEdit, onKeyChord }
}

function setupBytes(readOnly = false) {
  let binary: { bytes: Uint8Array<ArrayBuffer>; fileType: string } | null = null
  const onEdit = vi.fn()
  const onBytesEdit = vi.fn((document: { bytes: Uint8Array<ArrayBuffer>; fileType: string }) => {
    binary = document
  })
  const onEditRefused = vi.fn()
  const h = harness({
    getDocument: () => ({ text: '', readOnly }),
    getBinaryDocument: () => binary,
    onEdit,
    onBytesEdit,
    onEditRefused
  })
  return {
    ...h,
    onEdit,
    onBytesEdit,
    onEditRefused,
    load: (bytes: number[]) => {
      binary = { bytes: new Uint8Array(bytes), fileType: 'xlsx' }
      return binary
    }
  }
}

const bytesEdit = (bytes: number[], baseVersion = 1, id?: number) =>
  applyEdit({ kind: 'bytes', bytes: new Uint8Array(bytes).buffer }, baseVersion, id)

describe('custom editor bytes documents', () => {
  it('applies a full bytes replacement once, without echoing it back', () => {
    const { host, onEdit, onBytesEdit, send, documents, answers, load } = setupBytes()
    load([1])
    send(READY)
    send(applyEdit({ kind: 'text', text: 'x' }, 1, 1))
    send(bytesEdit([7, 8], 1, 2))
    expect(onEdit).not.toHaveBeenCalled()
    expect(answers(1)).toMatchObject([{ error: { code: 'invalid_params' } }])
    expect(answers(2)).toEqual([{ orca: 1, kind: 'res', id: 2, result: null }])
    expect(onBytesEdit).toHaveBeenCalledOnce()
    expect([...onBytesEdit.mock.calls[0][0].bytes]).toEqual([7, 8])
    expect(onBytesEdit.mock.calls[0][0].fileType).toBe('xlsx')
    host.syncDocument()
    expect(documents()).toHaveLength(1)
  })

  it('rejects a bytes edit made against a replaced document as a conflict', () => {
    const { host, onBytesEdit, send, answers, load } = setupBytes()
    load([1])
    send(READY)
    load([2])
    host.syncDocument()
    send(bytesEdit([9], 1, 3))
    expect(onBytesEdit).not.toHaveBeenCalled()
    expect(answers(3)).toMatchObject([{ error: { code: 'conflict', retryable: true } }])
  })

  it('refuses bytes edits on a read-only tab, and one over the size cap', () => {
    const viewer = setupBytes(true)
    viewer.load([1])
    viewer.send(READY)
    viewer.send(bytesEdit([2], 1, 4))
    expect(viewer.onBytesEdit).not.toHaveBeenCalled()
    expect(viewer.answers(4)).toMatchObject([{ error: { code: 'not_permitted' } }])
    const { onBytesEdit, onEditRefused, send, answers, load } = setupBytes()
    load([1])
    send(READY)
    send(
      applyEdit(
        { kind: 'bytes', bytes: new ArrayBuffer(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1) },
        1,
        5
      )
    )
    expect(onBytesEdit).not.toHaveBeenCalled()
    expect(onEditRefused).toHaveBeenCalledWith('oversized')
    expect(answers(5)).toMatchObject([{ error: { code: 'too_large', retryable: false } }])
  })
})

describe('custom editor document channel', () => {
  it('round-trips an edit into the buffer without echoing it back', () => {
    const { host, onEdit, send, documents } = setup({ text: 'a' })
    send(READY)
    send(edit('b'))
    expect(onEdit).toHaveBeenCalledWith('b')
    host.syncDocument()
    expect(documents()).toHaveLength(1)
  })

  it('ignores messages from any window but the editor frame', () => {
    const { onEdit, messages, send } = setup({ text: 'a' })
    send(READY, {})
    send(edit('b'), null)
    expect(messages()).toEqual([])
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('refuses an edit over the size cap, tells the frame, and blocks the save', async () => {
    const { host, onEdit, onEditRefused, onUnappliedEdit, send, answers, answerFlushes } = setup({
      text: 'a'
    })
    send(READY)
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1), 1, 12))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onEditRefused).toHaveBeenCalledWith('oversized')
    expect(onUnappliedEdit).toHaveBeenLastCalledWith('lost')
    expect(answers(12)).toMatchObject([{ error: { code: 'too_large', retryable: false } }])
    const flushed = host.flush()
    answerFlushes()
    // The buffer lacks the frame's latest change: a save must not mark the tab clean.
    await expect(flushed).resolves.toBe(false)
    send(edit('fits'))
    expect(onUnappliedEdit).toHaveBeenLastCalledWith(null)
    const caughtUp = host.flush()
    answerFlushes()
    await expect(caughtUp).resolves.toBe(true)
  })

  it('holds the newest rate-limited edit, answers superseded ones, and applies it before a save', async () => {
    const { host, onEdit, onUnappliedEdit, send, answers, answerFlushes } = setup({
      text: 'a',
      maxEdits: 1
    })
    send(READY)
    send(edit('b', 1, 13))
    send(edit('c', 1, 14))
    send(edit('d', 1, 15))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onUnappliedEdit).toHaveBeenLastCalledWith('held')
    // `c` is superseded by the full-document `d`, so it gets `d`'s answer once `d` commits.
    expect(answers(14)).toEqual([])
    expect(answers(15)).toEqual([])
    const flushed = host.flush()
    answerFlushes()
    await expect(flushed).resolves.toBe(true)
    expect(onEdit).toHaveBeenLastCalledWith('d')
    expect(answers(14)).toEqual([{ orca: 1, kind: 'res', id: 14, result: null }])
    expect(answers(15)).toEqual([{ orca: 1, kind: 'res', id: 15, result: null }])
    expect(onUnappliedEdit).toHaveBeenLastCalledWith(null)
  })

  it('gives a superseded held edit the refusal of the edit that replaced it', async () => {
    const { host, doc, send, answers, answerFlushes } = setup({ text: 'a', maxEdits: 1 })
    send(READY)
    send(edit('b', 1, 16))
    send(edit('c', 1, 17))
    doc.text = 'outside'
    host.syncDocument()
    send(edit('d', 1, 18))
    const flushed = host.flush()
    answerFlushes()
    await flushed
    expect(answers(17)).toMatchObject([{ error: { code: 'conflict' } }])
    expect(answers(18)).toMatchObject([{ error: { code: 'conflict' } }])
  })

  it('keeps a held edit when an oversized one follows, and the save stays blocked', async () => {
    let clock = 0
    const { host, onEdit, send, answers, answerFlushes } = setup({
      text: 'a',
      maxEdits: 1,
      now: () => clock
    })
    send(READY)
    send(edit('b', 1, 19))
    send(edit('c', 1, 20))
    // A new rate window, so the next edit is refused for its size alone.
    clock = 60_000
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1), 1, 21))
    // `c` is not answered as a success before it reaches the buffer.
    expect(answers(20)).toEqual([])
    expect(answers(21)).toMatchObject([{ error: { code: 'too_large' } }])
    const flushed = host.flush()
    answerFlushes()
    expect(onEdit).toHaveBeenLastCalledWith('c')
    expect(answers(20)).toEqual([{ orca: 1, kind: 'res', id: 20, result: null }])
    // The frame's newest change was lost, so a save must not mark the tab clean.
    await expect(flushed).resolves.toBe(false)
  })

  it('commits a held edit when a save starts, and every edit during the save at once', async () => {
    const { host, onEdit, send, answers, answerFlushes } = setup({ text: 'a', maxEdits: 1 })
    send(READY)
    send(edit('b', 1, 22))
    send(edit('c', 1, 23))
    expect(answers(23)).toEqual([])
    const flushed = host.flush()
    // The frame answers a save only once its edits settle, so the held one commits first.
    expect(onEdit).toHaveBeenLastCalledWith('c')
    expect(answers(23)).toEqual([{ orca: 1, kind: 'res', id: 23, result: null }])
    send(edit('d', 1, 24))
    expect(onEdit).toHaveBeenLastCalledWith('d')
    answerFlushes()
    await expect(flushed).resolves.toBe(true)
    send(edit('e', 1, 25))
    expect(answers(25)).toEqual([])
  })

  it('waits for the frame to flush before a save, and times out if it never answers', async () => {
    const { host, send, messages } = setup({ text: 'a' })
    send(READY)
    const flushed = host.flush()
    expect(messages().at(-1)).toEqual({ orca: 1, kind: 'req', id: 0, method: 'editor.flush' })
    send(edit('pending'))
    send({ orca: 1, kind: 'res', id: 0, result: null })
    await expect(flushed).resolves.toBe(true)
    // A frame that never answers holds edits Orca can't see.
    await expect(host.flush()).resolves.toBe(false)
  })

  it('a remounted frame must announce ready before it receives the document again', () => {
    const { host, send, documents } = setup({ text: 'a' })
    send(READY)
    host.reset()
    host.syncDocument()
    expect(documents()).toHaveLength(1)
    send(READY)
    expect(documents()).toHaveLength(2)
  })

  it('settles a merge only on the edit made against its own version', async () => {
    const onMergesOutside = vi.fn()
    const onKeyChord = vi.fn()
    const { host, send, documents, onEdit } = setupWith({
      text: 'a+mine',
      onMergesOutside,
      onKeyChord
    })
    send(READY)
    await expect(host.mergeOutsideChange('a+agent', 'a')).resolves.toBeNull()
    send({ orca: 1, kind: 'evt', event: 'editor.merges', payload: {} })
    expect(onMergesOutside).toHaveBeenCalledOnce()
    const merged = host.mergeOutsideChange('a+mine+agent', 'a')
    expect(documents().at(-1)).toMatchObject({
      payload: {
        version: 2,
        content: { kind: 'text', text: 'a+mine+agent' },
        ancestor: { kind: 'text', text: 'a' }
      }
    })
    // The merge result equals the disk text just sent; it still has to reach the buffer.
    send(edit('a+mine+agent', 2))
    await expect(merged).resolves.toBe('a+mine+agent')
    expect(onEdit).toHaveBeenLastCalledWith('a+mine+agent')
    // Events after the capability still reach their handlers (Save included).
    send(
      keydown({
        key: 's',
        code: 'KeyS',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false
      })
    )
    expect(onKeyChord).toHaveBeenCalledOnce()
  })

  it('answers null when the session never acknowledges, or the frame remounts', async () => {
    vi.useFakeTimers()
    try {
      const { host, send } = setupWith({ text: 'a', onMergesOutside: vi.fn() })
      send(READY)
      send({ orca: 1, kind: 'evt', event: 'editor.merges', payload: {} })
      const silent = host.mergeOutsideChange('b', 'a')
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(silent).resolves.toBeNull()
      // A frame whose merge threw edits against the old version: refused, never the acknowledgement.
      const failed = host.mergeOutsideChange('b2', 'a')
      send(edit('a+typed', 1, 77))
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(failed).resolves.toBeNull()
      const remounted = host.mergeOutsideChange('c', 'a')
      host.reset()
      await expect(remounted).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
