import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_EDITOR_DOCUMENT_MAX_BYTES } from '../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import { createPanelMessageBudget } from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import { createPluginFrameMessageHandler } from '../right-sidebar/plugin-frame-host'
import { createCustomEditorHost, type CustomEditorHostOptions } from './plugin-custom-editor-host'

vi.mock('../right-sidebar/plugin-panel-design-token-css', () => ({
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

function setup(initial: { text: string; readOnly?: boolean; maxEdits?: number }) {
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
  it('waits for the bytes, then transfers a copy so a remounted frame can get them again', () => {
    const { host, posted, send, documents, load } = setupBytes(true)
    send(READY)
    expect(documents()).toEqual([])
    const loaded = load([0x50, 0x4b, 3, 4])
    host.syncDocument()
    expect(documents()).toHaveLength(1)
    const { message, transfer } = posted.at(-1)!
    expect(message).toMatchObject({
      orca: 1,
      kind: 'evt',
      event: 'editor.document',
      payload: { version: 1, readOnly: true, fileType: 'xlsx', content: { kind: 'bytes' } }
    })
    const bytes =
      isPluginJsonObject(message) &&
      isPluginJsonObject(message.payload) &&
      isPluginJsonObject(message.payload.content)
        ? message.payload.content.bytes
        : null
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect(bytes instanceof ArrayBuffer && [...new Uint8Array(bytes)]).toEqual([0x50, 0x4b, 3, 4])
    expect(transfer).toEqual([bytes])
    expect(bytes).not.toBe(loaded.bytes.buffer)
    host.syncDocument()
    expect(documents()).toHaveLength(1)
  })

  it('sends new bytes with a higher version after an outside change', () => {
    const { host, send, documents, load } = setupBytes()
    load([1])
    send(READY)
    load([2])
    host.syncDocument()
    expect(documents()).toMatchObject([{ payload: { version: 1 } }, { payload: { version: 2 } }])
  })

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

describe('custom editor document versions', () => {
  it('applies an edit made against the current version and answers it', () => {
    const { onEdit, send, answers } = setup({ text: 'a' })
    send(READY)
    send(edit('b', 1, 6))
    expect(onEdit).toHaveBeenCalledWith('b')
    expect(answers(6)).toEqual([{ orca: 1, kind: 'res', id: 6, result: null }])
  })

  it('refuses a stale edit with a conflict instead of overwriting the outside change', () => {
    const { host, doc, onEdit, send, answers } = setup({ text: 'a' })
    send(READY)
    doc.text = 'changed on disk'
    host.syncDocument()
    send(edit('mine', 1, 7))
    expect(onEdit).not.toHaveBeenCalled()
    expect(answers(7)).toEqual([
      {
        orca: 1,
        kind: 'res',
        id: 7,
        error: { code: 'conflict', message: expect.any(String), retryable: true }
      }
    ])
  })

  it('refuses an edit that names no version or carries an unknown field', () => {
    const { onEdit, send, answers } = setup({ text: 'a' })
    send(READY)
    send({
      orca: 1,
      kind: 'req',
      id: 8,
      method: 'editor.applyEdit',
      params: { content: { kind: 'text', text: 'x' } }
    })
    send({
      orca: 1,
      kind: 'req',
      id: 9,
      method: 'editor.applyEdit',
      params: { baseVersion: 1, content: { kind: 'text', text: 'x' }, force: true }
    })
    expect(onEdit).not.toHaveBeenCalled()
    expect(answers(8)).toMatchObject([{ error: { code: 'invalid_params' } }])
    expect(answers(9)).toMatchObject([{ error: { code: 'invalid_params' } }])
  })
})

describe('custom editor document channel', () => {
  it('sends hello then the buffer once the editor is ready, and nothing before', () => {
    const { host, send, messages } = setup({ text: '{"type":"excalidraw"}' })
    host.syncDocument()
    expect(messages()).toEqual([])
    send(READY)
    expect(messages()).toEqual([
      expect.objectContaining({ kind: 'evt', event: 'hello' }),
      {
        orca: 1,
        kind: 'evt',
        event: 'editor.document',
        payload: {
          version: 1,
          readOnly: false,
          content: { kind: 'text', text: '{"type":"excalidraw"}' }
        }
      }
    ])
  })

  it('round-trips an edit into the buffer without echoing it back', () => {
    const { host, onEdit, send, documents } = setup({ text: 'a' })
    send(READY)
    send(edit('b'))
    expect(onEdit).toHaveBeenCalledWith('b')
    host.syncDocument()
    expect(documents()).toHaveLength(1)
  })

  it('does not dirty the buffer for an edit equal to what it already holds', () => {
    const { onEdit, send } = setup({ text: 'same' })
    send(READY)
    send(edit('same'))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('pushes outside changes such as a reload from disk', () => {
    const { host, doc, send, documents } = setup({ text: 'old' })
    send(READY)
    doc.text = 'reloaded'
    host.syncDocument()
    expect(documents().at(-1)).toMatchObject({
      payload: { version: 2, readOnly: false, content: { kind: 'text', text: 'reloaded' } }
    })
  })

  it('refuses edits before ready and for read-only documents', () => {
    const { onEdit, send, answers } = setup({ text: 'a', readOnly: true })
    send(edit('early', 1, 10))
    send(READY)
    send(edit('b', 1, 11))
    expect(onEdit).not.toHaveBeenCalled()
    expect(answers(10)).toMatchObject([{ error: { code: 'unavailable' } }])
    expect(answers(11)).toMatchObject([{ error: { code: 'not_permitted' } }])
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
    // `c` is superseded by the full-document `d`, so it succeeded.
    expect(answers(14)).toEqual([{ orca: 1, kind: 'res', id: 14, result: null }])
    expect(answers(15)).toEqual([])
    const flushed = host.flush()
    answerFlushes()
    await expect(flushed).resolves.toBe(true)
    expect(onEdit).toHaveBeenLastCalledWith('d')
    expect(answers(15)).toEqual([{ orca: 1, kind: 'res', id: 15, result: null }])
    expect(onUnappliedEdit).toHaveBeenLastCalledWith(null)
  })

  it('never spends the edit budget on chords or flush replies', () => {
    const { onEdit, send } = setup({ text: 'a', maxEdits: 1 })
    send(READY)
    for (let index = 0; index < 5; index += 1) {
      send(keydown({ key: 's', code: 'KeyS', metaKey: true }))
      send({ orca: 1, kind: 'res', id: index, result: null })
    }
    send(edit('b'))
    expect(onEdit).toHaveBeenCalledWith('b')
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

  it('forwards key chords from the shell for Orca to match, dropping malformed ones', () => {
    const { onKeyChord, send } = setup({ text: 'a' })
    send(keydown({ key: 'x'.repeat(65), code: 'a' }))
    expect(onKeyChord).not.toHaveBeenCalled()
    send(keydown({ key: 's', code: 'KeyS', metaKey: true }))
    expect(onKeyChord).toHaveBeenCalledWith(
      expect.objectContaining({ key: 's', metaKey: true, ctrlKey: false })
    )
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
})
