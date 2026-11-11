// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn(),
  readClipboardImageThumbnail: vi.fn(),
  clipboardHasImage: vi.fn(),
  readClipboardFilePaths: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
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
    }
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
  mocks.readClipboardText.mockResolvedValue('')
  mocks.readClipboardImageThumbnail.mockResolvedValue(null)
  mocks.clipboardHasImage.mockResolvedValue(true)
  mocks.readClipboardFilePaths.mockResolvedValue([])
  mocks.saveClipboardImageAsTempFile.mockResolvedValue(null)
})

afterEach(() => {
  unmountPasteProbe()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('useNativeChatComposerPaste', () => {
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
