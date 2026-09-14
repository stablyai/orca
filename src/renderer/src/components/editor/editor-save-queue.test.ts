import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeRuntimeFile } = vi.hoisted(() => ({
  writeRuntimeFile: vi.fn(async (..._args: unknown[]) => {})
}))

vi.mock('@/runtime/runtime-file-client', () => ({ writeRuntimeFile }))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: () => ({ connectionId: null })
}))

import { createEditorSaveQueue } from './editor-save-queue'

function makeStore(draft?: string) {
  const openFile = {
    id: 'f1',
    filePath: 'C:/tmp/book.xlsx',
    readOnly: false,
    isDirty: true,
    worktreeId: null
  }
  const state = {
    openFiles: [openFile],
    editorDrafts: draft === undefined ? {} : { f1: draft },
    worktreesByRepo: {},
    markFileDirty: vi.fn(),
    clearEditorDraft: vi.fn(),
    setLastKnownDiskSignature: vi.fn(),
    clearPendingDiskBaselineVerification: vi.fn(),
    setExternalMutation: vi.fn()
  }
  return { getState: () => state, subscribe: () => () => {}, openFile, state }
}

describe('editor save queue encoding', () => {
  beforeEach(() => {
    writeRuntimeFile.mockClear()
    // The queue touches `window` for timers/events; this suite runs in node.
    vi.stubGlobal('window', {
      dispatchEvent: () => true,
      clearTimeout: () => {},
      setTimeout: () => 0
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes the base64 payload even when a stale text draft exists', async () => {
    const store = makeStore('STALE-TEXT-DRAFT')
    const queue = createEditorSaveQueue(store as never)

    await queue.queueSave(store.openFile as never, 'BASE64-PAYLOAD', 'user', 'base64')

    expect(writeRuntimeFile).toHaveBeenCalledTimes(1)
    const [, , content, encoding] = writeRuntimeFile.mock.calls[0]!
    expect(content).toBe('BASE64-PAYLOAD')
    expect(encoding).toBe('base64')
  })

  it('still prefers the live draft for text saves', async () => {
    const store = makeStore('LIVE-DRAFT')
    const queue = createEditorSaveQueue(store as never)

    await queue.queueSave(store.openFile as never, 'FALLBACK', 'user')

    expect(writeRuntimeFile.mock.calls[0]![2]).toBe('LIVE-DRAFT')
  })

  it('falls back to the provided content when there is no draft', async () => {
    const store = makeStore()
    const queue = createEditorSaveQueue(store as never)

    await queue.queueSave(store.openFile as never, 'FALLBACK', 'user')

    expect(writeRuntimeFile.mock.calls[0]![2]).toBe('FALLBACK')
  })
})
