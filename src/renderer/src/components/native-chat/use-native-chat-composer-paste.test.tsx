// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

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

vi.mock('./native-chat-composer-target', () => ({
  NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES: 1024
}))

vi.mock('./native-chat-attachment-upload', () => ({
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
  it('does not save a clipboard image locally for a remote runtime', async () => {
    mocks.clipboardHasImage.mockResolvedValue(true)
    const setNotice = vi.fn()
    const store = createChipStore()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'remote' }),
      store,
      setNotice
    })

    await act(async () => probe.latest().pasteFromClipboard())

    expect(setNotice).toHaveBeenCalledWith(
      'Local attachments are not available for remote sessions.'
    )
    expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(mocks.readClipboardImageThumbnail).not.toHaveBeenCalled()
    expect(store.chips).toHaveLength(0)
  })

  it.each(['event', 'menu'] as const)(
    'saves a clipboard image on the server whose host runs the agent via %s paste (#27997)',
    async (source) => {
      mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/remote.png')
      const store = createChipStore()
      const owner = { kind: 'remote', clipboardImageEnvironmentId: 'env-1' } as const
      const probe = await renderProbe({ resolveAttachmentOwner: () => owner, store })
      await act(async () =>
        source === 'event'
          ? probe.latest().handlePaste(imagePasteEvent())
          : probe.latest().pasteFromClipboard()
      )
      expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
        runtimeEnvironmentId: 'env-1'
      })
      expect(store.chips).toEqual([expect.objectContaining({ path: '/tmp/remote.png' })])
    }
  )

  it('rejects a remote image saved before the chat moved to another server', async () => {
    let owner: NativeChatAttachmentOwner = { kind: 'remote', clipboardImageEnvironmentId: 'env-1' }
    let resolveSave: (path: string) => void = () => {}
    mocks.saveClipboardImageAsTempFile.mockReturnValue(new Promise((r) => (resolveSave = r)))
    const store = createChipStore()
    const probe = await renderProbe({ resolveAttachmentOwner: () => owner, store })
    await act(async () => probe.latest().handlePaste(imagePasteEvent()))
    owner = { kind: 'remote', clipboardImageEnvironmentId: 'env-2' }
    await act(async () => resolveSave('/tmp/remote.png'))
    expect(store.chips).toHaveLength(0)
  })

  it('surfaces a failed image save through the composer notice', async () => {
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(new Error('Disk full.'))
    const store = createChipStore()
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      store,
      setNotice
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(setNotice).toHaveBeenCalledWith('Disk full.')
    expect(store.chips).toHaveLength(0)
  })

  it.each(['event', 'menu'] as const)(
    'attaches OMP clipboard images for reference delivery via %s paste',
    async (source) => {
      mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/omp.png')
      mocks.readClipboardImageThumbnail.mockResolvedValue(null)
      const store = createChipStore()
      const attachResolvedPaths = vi.fn()
      const setNotice = vi.fn()
      const probe = await renderProbe({
        agent: 'omp',
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        store,
        attachResolvedPaths,
        setNotice
      })
      await act(async () => {
        if (source === 'event') {
          probe.latest().handlePaste(imagePasteEvent())
        } else {
          probe.latest().pasteFromClipboard()
        }
      })
      expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({ forNativeChatDraft: true })
      expect(attachResolvedPaths).toHaveBeenCalledWith(['/tmp/omp.png'], null)
      expect(setNotice.mock.calls.every(([notice]) => notice === null)).toBe(true)
    }
  )

  it('saves a local paste where its draft can bring it back after a restart', async () => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue(
      '/Users/me/Library/Application Support/orca/native-chat-pastes/orca-paste-1.png'
    )
    const probe = await renderProbe({ resolveAttachmentOwner: () => ({ kind: 'local' }) })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({ forNativeChatDraft: true })
  })

  it("keeps a local structured chat's paste where that chat's send claims it", async () => {
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local', structuredSessionId: 'session-1' })
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      forNativeChatDraft: true,
      forStructuredChat: true
    })
  })

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

  it('shows a pending chip for menu paste from the clipboard thumbnail probe', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue({
      dataUrl: 'data:image/png;base64,AAA',
      width: 1200,
      height: 800
    })
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
      probe.latest().pasteFromClipboard()
    })
    expect(store.chips).toEqual([
      { id: 'chip-1', path: '', previewUrl: 'data:image/png;base64,AAA', pending: true }
    ])
    await act(async () => {
      resolveSave('/tmp/orca-paste-2.png')
    })
    expect(store.chips[0]).toMatchObject({ path: '/tmp/orca-paste-2.png', pending: false })
  })

  it('settles the owned operation when no clipboard preview was available', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue(null)
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('C:\\Temp\\orca-paste-3.png')
    const store = createChipStore()
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      store,
      attachResolvedPaths
    })
    await act(async () => {
      probe.latest().pasteFromClipboard()
    })
    expect(store.chips[0]).toMatchObject({ path: 'C:\\Temp\\orca-paste-3.png', pending: false })
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('inserts text independently of a failed image save', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue(null)
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(new Error('sftp down'))
    mocks.readClipboardText.mockResolvedValue('안녕하세요')
    const insertTypedText = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText,
      setNotice
    })
    await act(async () => {
      probe.latest().pasteFromClipboard()
    })
    expect(setNotice).toHaveBeenCalledWith('sftp down')
    expect(insertTypedText).toHaveBeenCalledWith('안녕하세요')
  })

  it('still falls through to text when the clipboard holds no image', async () => {
    mocks.clipboardHasImage.mockResolvedValue(false)
    mocks.readClipboardText.mockResolvedValue('hello')
    const insertTypedText = vi.fn()
    const store = createChipStore()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      store,
      insertTypedText
    })
    await act(async () => {
      probe.latest().pasteFromClipboard()
    })
    expect(insertTypedText).toHaveBeenCalledWith('hello')
    expect(store.chips).toHaveLength(0)
  })

  it('drops the pending chip when the clipboard changed between probe and save', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue({
      dataUrl: 'data:image/png;base64,AAA',
      width: 10,
      height: 10
    })
    mocks.saveClipboardImageAsTempFile.mockResolvedValue(null)
    mocks.readClipboardText.mockResolvedValue('hello')
    const store = createChipStore()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      store
    })
    await act(async () => {
      probe.latest().pasteFromClipboard()
    })
    expect(store.chips).toHaveLength(0)
  })

  it('suppresses the failure notice when the composer became disabled mid-save', async () => {
    let rejectSave: (error: Error) => void = () => {}
    mocks.saveClipboardImageAsTempFile.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject
      })
    )
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      setNotice
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    await probe.setDisabled(true)
    await act(async () => {
      rejectSave(new Error('sftp down'))
    })
    expect(setNotice.mock.calls.every(([notice]) => notice === null)).toBe(true)
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

  it.each([false, true, null, 'error'] as const)(
    'preserves remote text when image presence is %s',
    async (presence) => {
      if (presence === 'error') {
        mocks.clipboardHasImage.mockRejectedValue(new Error('denied'))
      } else {
        mocks.clipboardHasImage.mockResolvedValue(presence)
      }
      mocks.readClipboardText.mockResolvedValue('hello')
      const insertTypedText = vi.fn(() => true)
      const setNotice = vi.fn()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind: 'remote' }),
        insertTypedText,
        setNotice
      })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('hello')
      // Text wins: no second (browser-prompting) clipboard read and no refusal beside the text.
      expect(mocks.clipboardHasImage).not.toHaveBeenCalled()
      expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toHaveLength(0)
    }
  )

  it.each(['remote', 'not-ready'] as const)(
    'still explains an image-only menu paste on %s',
    async (kind) => {
      mocks.clipboardHasImage.mockResolvedValue(true)
      const setNotice = vi.fn()
      const probe = await renderProbe({ resolveAttachmentOwner: () => ({ kind }), setNotice })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(mocks.clipboardHasImage).toHaveBeenCalledTimes(1)
      expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toHaveLength(1)
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

  it('rejects an image saved across a host change', async () => {
    let owner: NativeChatAttachmentOwner = { kind: 'local' }
    let finish = (_path: string): void => {}
    mocks.saveClipboardImageAsTempFile.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const store = createChipStore()
    const probe = await renderProbe({ resolveAttachmentOwner: () => owner, store })
    await act(async () => probe.latest().handlePaste(imagePasteEvent()))
    owner = { kind: 'remote' }
    await act(async () => finish('/tmp/old-host.png'))
    expect(store.chips).toHaveLength(0)
  })
})

it('inserts event text locally without any clipboard API access', async () => {
  const insertTypedText = vi.fn(() => true)
  const probe = await renderProbe({
    resolveAttachmentOwner: () => ({ kind: 'remote' }),
    insertTypedText
  })
  const data = new DataTransfer()
  data.setData('text/plain', '한글\nplain')
  const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
  await act(async () => probe.latest().handlePaste(event))
  expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('한글\nplain')
  expect(event.defaultPrevented).toBe(true)
  expect(mocks.readClipboardText).not.toHaveBeenCalled()
  expect(mocks.clipboardHasImage).not.toHaveBeenCalled()
  expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
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

describe('pastes the composer cannot take', () => {
  const REFUSAL = "Can't paste — this chat isn't accepting input right now."

  it.each(['event', 'menu'] as const)(
    'explains a %s paste into a disabled composer',
    async (source) => {
      const insertTypedText = vi.fn(() => true)
      const setNotice = vi.fn()
      mocks.readClipboardText.mockResolvedValue('hello')
      const probe = await renderProbe({
        disabled: true,
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        insertTypedText,
        setNotice
      })
      await act(async () => {
        if (source === 'event') {
          const data = new DataTransfer()
          data.setData('text/plain', 'hello')
          probe
            .latest()
            .handlePaste(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
        } else {
          probe.latest().pasteFromClipboard()
        }
      })
      expect(insertTypedText).not.toHaveBeenCalled()
      expect(mocks.readClipboardText).not.toHaveBeenCalled()
      expect(setNotice).toHaveBeenCalledWith(REFUSAL)
    }
  )

  it('explains text the composer input could not accept', async () => {
    const setNotice = vi.fn()
    mocks.readClipboardText.mockResolvedValue('hello')
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText: () => false,
      setNotice
    })
    await act(async () => probe.latest().pasteFromClipboard())
    expect(setNotice).toHaveBeenLastCalledWith(REFUSAL)
  })
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
    ['a single file', [png('shot.png')], 'shot.png'],
    [
      'several files',
      [png('a.png'), new File(['pdf'], 'b.pdf', { type: 'application/pdf' })],
      'a.png\nb.pdf'
    ],
    ['a file label with a trailing newline', [png('shot.png')], 'shot.png\r\n']
  ])('attaches %s without inserting its name', async (_label, files, text) => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/shot.png')
    const insertTypedText = vi.fn(() => true)
    const store = createChipStore()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText,
      store
    })
    await act(async () => probe.latest().handlePaste(fileCopyEvent(files, text)))
    expect(insertTypedText).not.toHaveBeenCalled()
    expect(store.chips).toEqual([
      expect.objectContaining({ path: '/tmp/shot.png', pending: false })
    ])
  })

  it.each([
    ['rich text with an image rendition', [png('image.png')], 'Quarterly numbers'],
    [
      'a non-image file, which is not attached',
      [new File(['pdf'], 'b.pdf', { type: 'application/pdf' })],
      'b.pdf'
    ]
  ])('still inserts the text of %s', async (_label, files, text) => {
    const insertTypedText = vi.fn(() => true)
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText
    })
    await act(async () => probe.latest().handlePaste(fileCopyEvent(files, text)))
    expect(insertTypedText).toHaveBeenCalledExactlyOnceWith(text)
  })

  it.each([
    ['a path', '/home/me/shot.png'],
    ['a file URL', 'file:///home/me/my%20shot.png']
  ])('attaches a Linux file manager copy labelled by %s without typing it', async (_l, text) => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/shot.png')
    const insertTypedText = vi.fn(() => true)
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText
    })
    const name = text.includes('my%20') ? 'my shot.png' : 'shot.png'
    await act(async () => probe.latest().handlePaste(fileCopyEvent([png(name)], text)))
    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('attaches pasted files that have local paths as a drop would, typing nothing', async () => {
    mocks.getPathForFile.mockImplementation((file: File) => `/Users/me/${file.name}`)
    const insertTypedText = vi.fn(() => true)
    const attachCopiedFiles = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText,
      attachCopiedFiles
    })
    const files = [png('shot.png'), new File(['pdf'], 'b.pdf', { type: 'application/pdf' })]
    await act(async () => probe.latest().handlePaste(fileCopyEvent(files, 'shot.png\nb.pdf')))
    expect(attachCopiedFiles).toHaveBeenCalledExactlyOnceWith(
      ['/Users/me/shot.png', '/Users/me/b.pdf'],
      { focus: false }
    )
    expect(insertTypedText).not.toHaveBeenCalled()
    expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

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

  describe('from the app menu (macOS Cmd+V)', () => {
    it.each([
      ['a single file', 'shot.png', ['/Users/me/Desktop/shot.png'], true],
      ['several files', 'a.png\rb.pdf', ['/Users/me/a.png', '/Users/me/b.pdf'], true],
      ['a file with no image rendition', 'notes.txt', ['/Users/me/notes.txt'], false]
    ])(
      'attaches %s as a drop would, without typing the Finder label',
      async (_label, text, paths, hasImage) => {
        mocks.readClipboardText.mockResolvedValue(text)
        mocks.readClipboardFilePaths.mockResolvedValue(paths)
        mocks.clipboardHasImage.mockResolvedValue(hasImage)
        const insertTypedText = vi.fn(() => true)
        const attachCopiedFiles = vi.fn()
        const probe = await renderProbe({
          resolveAttachmentOwner: () => ({ kind: 'local' }),
          insertTypedText,
          attachCopiedFiles
        })
        await act(async () => probe.latest().pasteFromClipboard())
        expect(attachCopiedFiles).toHaveBeenCalledExactlyOnceWith(paths, { focus: false })
        expect(insertTypedText).not.toHaveBeenCalled()
        // The copied file itself is attached, never the bitmap rendition beside it.
        expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
      }
    )

    it.each([
      ['macOS', 'Macintosh', false],
      ['other platforms', 'X11; Linux x86_64', true]
    ])(
      'on %s, treats a screenshot picture beside its saved file as files only off macOS',
      async (_label, platform, attachesFiles) => {
        // A screenshot tool's clipboard: the picture plus its saved file, which may be gone.
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${platform})`)
        mocks.readClipboardText.mockResolvedValue('')
        mocks.readClipboardFilePaths.mockResolvedValue(['/Users/me/Desktop/Screenshot.png'])
        mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/shot.png')
        const attachCopiedFiles = vi.fn()
        const probe = await renderProbe({
          resolveAttachmentOwner: () => ({ kind: 'local' }),
          attachCopiedFiles
        })
        await act(async () => probe.latest().pasteFromClipboard())
        expect(attachCopiedFiles).toHaveBeenCalledTimes(attachesFiles ? 1 : 0)
        expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledTimes(attachesFiles ? 0 : 1)
      }
    )

    it('types unrelated text at once, and when the file list cannot be read', async () => {
      mocks.readClipboardText.mockResolvedValue('see attached')
      mocks.readClipboardFilePaths.mockResolvedValue(['/Users/me/shot.png'])
      mocks.saveClipboardImageAsTempFile.mockReturnValue(new Promise(() => {}))
      const insertTypedText = vi.fn(() => true)
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        insertTypedText
      })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('see attached')

      mocks.readClipboardText.mockResolvedValue('shot.png')
      mocks.readClipboardFilePaths.mockRejectedValue(new Error('unavailable'))
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).toHaveBeenLastCalledWith('shot.png')
    })
  })
})
