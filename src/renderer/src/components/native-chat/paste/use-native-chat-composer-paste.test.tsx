// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn(),
  readClipboardImageThumbnail: vi.fn(),
  clipboardHasImage: vi.fn(),
  readClipboardFilePaths: vi.fn(),
  getPathForFile: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./native-chat-context-paste-limit', () => ({
  NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES: 1024
}))

vi.mock('../attachments/intake/native-chat-attachment-notices', () => ({
  nativeChatLocalAttachmentUnsupportedNotice: () =>
    'Local attachments are not available for remote sessions.',
  nativeChatWorktreeNotReadyNotice: () => 'Worktree not ready — try again in a moment.'
}))

vi.stubGlobal('window', {
  api: {
    ui: {
      saveClipboardImageAsTempFile: mocks.saveClipboardImageAsTempFile,
      readClipboardText: mocks.readClipboardText,
      readClipboardImageThumbnail: mocks.readClipboardImageThumbnail,
      clipboardHasImage: mocks.clipboardHasImage,
      readClipboardFilePaths: mocks.readClipboardFilePaths
    },
    fs: { getPathForFile: mocks.getPathForFile }
  }
})
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:clipboard-image',
  revokeObjectURL: () => {}
})

import {
  createChipStore,
  renderProbe,
  unmountPasteProbe
} from './native-chat-composer-paste-test-fixtures'

function imagePasteEvent(text = ''): ClipboardEvent {
  const data = new DataTransfer()
  data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  if (text) {
    data.setData('text/plain', text)
  }
  return new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
  mocks.readClipboardText.mockResolvedValue('')
  mocks.readClipboardImageThumbnail.mockResolvedValue(null)
  mocks.clipboardHasImage.mockResolvedValue(true)
  mocks.readClipboardFilePaths.mockResolvedValue([])
  mocks.getPathForFile.mockReturnValue('')
  mocks.saveClipboardImageAsTempFile.mockResolvedValue(null)
})

afterEach(() => {
  unmountPasteProbe()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('useNativeChatComposerPaste', () => {
  it('shows a pending chip before the save resolves', async () => {
    let resolveSave: (path: string) => void = () => {}
    mocks.saveClipboardImageAsTempFile.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSave = resolve
      })
    )
    const store = createChipStore()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      store
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(store.chips).toEqual([
      { id: 'chip-1', path: '', previewUrl: 'blob:clipboard-image', pending: true }
    ])
    await act(async () => {
      resolveSave('/tmp/orca-paste-1.png')
    })
    expect(store.chips[0]).toMatchObject({ path: '/tmp/orca-paste-1.png', pending: false })
  })

  it('does not settle a local path after the attachment owner changes', async () => {
    let resolveSave: (path: string) => void = () => {}
    let owner: NativeChatAttachmentOwner = { kind: 'local' }
    mocks.saveClipboardImageAsTempFile.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSave = resolve
      })
    )
    const store = createChipStore()
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => owner,
      store,
      setNotice
    })

    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(store.chips).toHaveLength(1)

    owner = { kind: 'remote' }
    await act(async () => {
      resolveSave('/tmp/orca-paste-owner-changed.png')
    })

    expect(store.chips).toHaveLength(0)
    expect(setNotice).toHaveBeenCalledWith('Worktree not ready — try again in a moment.')
  })
})

describe('composer paste intake regressions', () => {
  it.each(['local', 'remote', 'not-ready'] as const)(
    'inserts text without waiting for an image operation on %s',
    async (kind) => {
      mocks.readClipboardText.mockResolvedValue('안녕하세요\nhello')
      mocks.saveClipboardImageAsTempFile.mockReturnValue(new Promise(() => {}))
      mocks.clipboardHasImage.mockReturnValue(new Promise(() => {}))
      const insertTypedText = vi.fn(() => true)
      const setNotice = vi.fn()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind }),
        insertTypedText,
        setNotice
      })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('안녕하세요\nhello')
      expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toHaveLength(0)
      if (kind === 'remote' || kind === 'not-ready') {
        expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['local', 'remote', 'not-ready'] as const)(
    'preserves mixed event text with %s attachments and deduplicates capture',
    async (kind) => {
      const insertTypedText = vi.fn(() => true)
      const setNotice = vi.fn()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind }),
        insertTypedText,
        setNotice
      })
      const event = imagePasteEvent('caption')
      await act(async () => {
        probe.latest().handlePaste(event)
        probe.latest().handlePaste(event)
      })
      expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('caption')
      expect(mocks.readClipboardText).not.toHaveBeenCalled()
      expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toHaveLength(0)
    }
  )

  it.each(['unmount', 'replace', 'disable'] as const)(
    'drops late text and pending images after target %s',
    async (change) => {
      let finishText = (_text: string): void => {}
      let finishImage = (_path: string): void => {}
      mocks.saveClipboardImageAsTempFile.mockReturnValue(
        new Promise<string>((resolve) => {
          finishImage = resolve
        })
      )
      mocks.readClipboardImageThumbnail.mockResolvedValue({
        dataUrl: 'data:image/png;base64,AA',
        width: 1,
        height: 1
      })
      const store = createChipStore()
      const insertTypedText = vi.fn(() => true)
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        insertTypedText,
        store
      })
      // An image still saving, then a second paste whose text read is still in flight.
      await act(async () => probe.latest().pasteFromClipboard())
      expect(store.chips).toHaveLength(1)
      mocks.readClipboardText.mockReturnValue(
        new Promise<string>((resolve) => {
          finishText = resolve
        })
      )
      await act(async () => probe.latest().pasteFromClipboard())
      if (change === 'unmount') {
        await act(async () => {
          unmountPasteProbe()
        })
      } else if (change === 'replace') {
        await probe.setTarget('session-2')
      } else {
        await probe.setDisabled(true)
      }
      await act(async () => {
        finishText('stale')
        finishImage('/tmp/stale.png')
      })
      expect(insertTypedText).not.toHaveBeenCalled()
      expect(store.chips).toHaveLength(0)
    }
  )
})

it('refuses oversized event text without inserting it', async () => {
  const insertTypedText = vi.fn(() => true)
  const setNotice = vi.fn()
  const probe = await renderProbe({
    resolveAttachmentOwner: () => ({ kind: 'remote' }),
    insertTypedText,
    setNotice
  })
  const data = new DataTransfer()
  data.setData('text/plain', 'x'.repeat(1025))
  await act(async () =>
    probe
      .latest()
      .handlePaste(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
  )
  expect(insertTypedText).not.toHaveBeenCalled()
  expect(setNotice).toHaveBeenCalledWith(expect.stringContaining('too large'))
})

describe('file-manager copies', () => {
  function fileCopyEvent(files: File[], text: string): ClipboardEvent {
    const data = new DataTransfer()
    for (const file of files) {
      data.items.add(file)
    }
    data.setData('text/plain', text)
    return new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
  }
  const png = (name: string): File => new File(['image'], name, { type: 'image/png' })

  it.each([
    ['a screenshot picture beside its saved file', '', false],
    ['a Finder copy, whose clipboard text names the file', 'Screenshot.png', true]
  ])(
    'on macOS, holds a chip at once for %s, then lets the clipboard decide',
    async (_label, nativeText, attachesFiles) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)')
      mocks.getPathForFile.mockImplementation((file: File) => `/Users/me/Desktop/${file.name}`)
      let finishRead: (text: string) => void = () => {}
      mocks.readClipboardText.mockReturnValue(
        new Promise<string>((resolve) => {
          finishRead = resolve
        })
      )
      mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/shot.png')
      const attachCopiedFiles = vi.fn()
      const continueCopiedFiles = vi.fn(async () => {})
      const store = createChipStore()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        attachCopiedFiles,
        continueCopiedFiles,
        store
      })
      await act(async () => probe.latest().handlePaste(fileCopyEvent([png('Screenshot.png')], '')))
      expect(store.chips).toEqual([expect.objectContaining({ pending: true })])
      await act(async () => finishRead(nativeText))
      // Files continue the chip reserved at paste time; no new attach starts.
      expect(attachCopiedFiles).not.toHaveBeenCalled()
      expect(continueCopiedFiles.mock.calls).toEqual(
        attachesFiles ? [[[{ path: '/Users/me/Desktop/Screenshot.png', chipId: 'chip-1' }]]] : []
      )
      expect(store.chips).toEqual([
        attachesFiles
          ? expect.objectContaining({ id: 'chip-1', pending: true })
          : expect.objectContaining({ path: '/tmp/shot.png', pending: false })
      ])
      expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledTimes(attachesFiles ? 0 : 1)
    }
  )
})
