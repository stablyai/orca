// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

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
    }
  }
})
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:clipboard-image',
  revokeObjectURL: () => {}
})

import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'

type HookApi = ReturnType<typeof useNativeChatComposerPaste>

/** Mirrors the composer's attachment list so tests can assert what the user sees. */
type FakeChip = { id: string; path: string; previewUrl?: string; pending: boolean }

function createChipStore(): {
  chips: FakeChip[]
  begin: (previewUrl?: string) => string | null
  resolve: (id: string, path: string, connectionId?: string | null) => void
  drop: (id: string) => void
  connectionIds: (string | null | undefined)[]
} {
  const chips: FakeChip[] = []
  const connectionIds: (string | null | undefined)[] = []
  let counter = 0
  return {
    chips,
    connectionIds,
    begin: (previewUrl) => {
      counter += 1
      const id = `chip-${counter}`
      chips.push({ id, path: '', previewUrl, pending: true })
      return id
    },
    resolve: (id, path, connectionId) => {
      const chip = chips.find((candidate) => candidate.id === id)
      if (chip) {
        chip.path = path
        chip.pending = false
      }
      connectionIds.push(connectionId)
    },
    drop: (id) => {
      const index = chips.findIndex((candidate) => candidate.id === id)
      if (index !== -1) {
        chips.splice(index, 1)
      }
    }
  }
}

type ProbeArgs = {
  targetKey?: string
  agent?: 'claude' | 'omp'
  disabled: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  dropPendingImageAttachment: (id: string) => void
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}

function Probe({ onReady, ...args }: ProbeArgs): null {
  onReady(useNativeChatComposerPaste({ agent: 'claude', caret: 0, setCaret: () => {}, ...args }))
  return null
}

let root: Root | null = null

async function renderProbe(args: {
  agent?: 'claude' | 'omp'
  disabled?: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths?: (paths: string[], connectionId?: string | null) => void
  store?: ReturnType<typeof createChipStore>
  insertTypedText?: (text: string) => boolean
  setNotice?: (notice: string | null) => void
}): Promise<{
  latest: () => HookApi
  setDisabled: (disabled: boolean) => Promise<void>
  setTarget: (key: string) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const store = args.store ?? createChipStore()
  let api: HookApi | null = null
  root = createRoot(container)
  let targetKey = 'session-1'
  const render = async (disabled: boolean): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          targetKey,
          agent: args.agent ?? 'claude',
          disabled,
          resolveAttachmentOwner: args.resolveAttachmentOwner,
          attachResolvedPaths: args.attachResolvedPaths ?? (() => {}),
          beginPendingImageAttachment: store.begin,
          resolvePendingImageAttachment: store.resolve,
          dropPendingImageAttachment: store.drop,
          insertTypedText: args.insertTypedText ?? (() => true),
          setNotice: args.setNotice ?? (() => {}),
          onReady: (next) => {
            api = next
          }
        })
      )
    })
  }
  await render(args.disabled ?? false)
  return {
    latest: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    setDisabled: render,
    setTarget: async (key) => {
      targetKey = key
      await render(false)
    }
  }
}

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
  mocks.clipboardHasImage.mockResolvedValue(false)
  mocks.readClipboardFilePaths.mockResolvedValue([])
  mocks.saveClipboardImageAsTempFile.mockResolvedValue(null)
})

const sshOwner: NativeChatAttachmentOwner = {
  kind: 'ssh',
  connectionId: 'conn-1',
  worktreePath: '/remote/wt',
  expectedExecutionHostId: 'ssh:conn-1',
  expectedSshTargetId: 'conn-1',
  expectedSshConnectionGeneration: 4
}

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatComposerPaste', () => {
  it('does not save a clipboard image locally for a remote runtime', async () => {
    mocks.clipboardHasImage.mockResolvedValue(true)
    const setNotice = vi.fn()
    const store = createChipStore()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'runtime' }),
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

  it('surfaces a failed SSH image save through the composer notice', async () => {
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(
      new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
    )
    const store = createChipStore()
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => sshOwner,
      store,
      setNotice
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(setNotice).toHaveBeenCalledWith(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )
    // The optimistic chip must not outlive a failed save.
    expect(store.chips).toHaveLength(0)
  })

  it.each(['event', 'menu'] as const)(
    'attaches OMP clipboard images for reference delivery via %s paste',
    async (source) => {
      mocks.saveClipboardImageAsTempFile.mockResolvedValue('/remote/tmp/omp.png')
      mocks.readClipboardImageThumbnail.mockResolvedValue(null)
      const store = createChipStore()
      const attachResolvedPaths = vi.fn()
      const setNotice = vi.fn()
      const probe = await renderProbe({
        agent: 'omp',
        resolveAttachmentOwner: () => sshOwner,
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
      expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({ connectionId: 'conn-1' })
      if (source === 'event') {
        expect(store.chips[0]?.path).toBe('/remote/tmp/omp.png')
      } else {
        expect(attachResolvedPaths).toHaveBeenCalledWith(['/remote/tmp/omp.png'], 'conn-1')
      }
      expect(setNotice.mock.calls.every(([notice]) => notice === null)).toBe(true)
    }
  )

  it('saves on the SSH host and settles the chip on the returned remote path', async () => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/remote/tmp/orca-paste-1.png')
    const store = createChipStore()
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => sshOwner,
      store,
      attachResolvedPaths
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({ connectionId: 'conn-1' })
    expect(store.chips).toEqual([
      {
        id: 'chip-1',
        path: '/remote/tmp/orca-paste-1.png',
        previewUrl: 'blob:clipboard-image',
        pending: false
      }
    ])
    // The chip carries the SSH connection so its preview reads over SFTP.
    expect(store.connectionIds).toEqual(['conn-1'])
    expect(attachResolvedPaths).not.toHaveBeenCalled()
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

    owner = sshOwner
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

  it('attaches directly when no clipboard preview was available', async () => {
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
    expect(store.chips).toHaveLength(0)
    expect(attachResolvedPaths).toHaveBeenCalledWith(['C:\\Temp\\orca-paste-3.png'], null)
  })

  it('inserts text independently of a failed image save', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue(null)
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(new Error('sftp down'))
    mocks.readClipboardText.mockResolvedValue('안녕하세요')
    const insertTypedText = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => sshOwner,
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
    mocks.readClipboardImageThumbnail.mockResolvedValue(null)
    mocks.saveClipboardImageAsTempFile.mockResolvedValue(null)
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
      resolveAttachmentOwner: () => sshOwner,
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
  it.each(['local', 'ssh', 'runtime', 'not-ready'] as const)(
    'inserts text without waiting for an image operation on %s',
    async (kind) => {
      mocks.readClipboardText.mockResolvedValue('안녕하세요\nhello')
      mocks.saveClipboardImageAsTempFile.mockReturnValue(new Promise(() => {}))
      mocks.clipboardHasImage.mockReturnValue(new Promise(() => {}))
      const insertTypedText = vi.fn(() => true)
      const setNotice = vi.fn()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => (kind === 'ssh' ? sshOwner : { kind }),
        insertTypedText,
        setNotice
      })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('안녕하세요\nhello')
      expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toHaveLength(0)
      if (kind === 'runtime' || kind === 'not-ready') {
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
        resolveAttachmentOwner: () => ({ kind: 'runtime' }),
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

  it.each(['runtime', 'not-ready'] as const)(
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

  it.each(['local', 'ssh', 'runtime', 'not-ready'] as const)(
    'preserves mixed event text with %s attachments and deduplicates capture',
    async (kind) => {
      const insertTypedText = vi.fn(() => true)
      const setNotice = vi.fn()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => (kind === 'ssh' ? sshOwner : { kind }),
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
      mocks.readClipboardText.mockReturnValue(
        new Promise<string>((resolve) => {
          finishText = resolve
        })
      )
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
      await act(async () => probe.latest().pasteFromClipboard())
      expect(store.chips).toHaveLength(1)
      if (change === 'unmount') {
        await act(async () => {
          root?.unmount()
          root = null
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

  it('rejects an image saved across SSH connection replacement', async () => {
    let owner = sshOwner
    let finish = (_path: string): void => {}
    mocks.saveClipboardImageAsTempFile.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const store = createChipStore()
    const probe = await renderProbe({ resolveAttachmentOwner: () => owner, store })
    await act(async () => probe.latest().handlePaste(imagePasteEvent()))
    owner = { ...sshOwner, expectedSshConnectionGeneration: 5 }
    await act(async () => finish('/tmp/old-host.png'))
    expect(store.chips).toHaveLength(0)
  })
})

it('inserts event text locally without any clipboard API access', async () => {
  const insertTypedText = vi.fn(() => true)
  const probe = await renderProbe({
    resolveAttachmentOwner: () => ({ kind: 'runtime' }),
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
    resolveAttachmentOwner: () => ({ kind: 'runtime' }),
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

  describe('from the app menu (macOS Cmd+V)', () => {
    it.each([
      ['a single file', 'shot.png', ['/Users/me/Desktop/shot.png']],
      ['several files', 'a.png\rb.pdf', ['/Users/me/a.png', '/Users/me/b.pdf']]
    ])('attaches %s without typing the Finder label', async (_label, text, paths) => {
      mocks.readClipboardText.mockResolvedValue(text)
      mocks.readClipboardFilePaths.mockResolvedValue(paths)
      mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/shot.png')
      const insertTypedText = vi.fn(() => true)
      const attachResolvedPaths = vi.fn()
      const probe = await renderProbe({
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        insertTypedText,
        attachResolvedPaths
      })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).not.toHaveBeenCalled()
      expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith(['/tmp/shot.png'], null)
    })

    it('types the label when no image came with the files', async () => {
      mocks.readClipboardText.mockResolvedValue('notes.txt')
      mocks.readClipboardFilePaths.mockResolvedValue(['/Users/me/notes.txt'])
      const insertTypedText = vi.fn(() => true)
      const probe = await renderProbe({
        resolveAttachmentOwner: () => sshOwner,
        insertTypedText
      })
      await act(async () => probe.latest().pasteFromClipboard())
      expect(insertTypedText).toHaveBeenCalledExactlyOnceWith('notes.txt')
    })

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

    it.each([
      [true, 0, 1],
      [false, 1, 0]
    ])(
      'on a remote runtime, image presence %s decides between the refusal and the label',
      async (hasImage, inserts, notices) => {
        mocks.readClipboardText.mockResolvedValue('shot.png')
        mocks.readClipboardFilePaths.mockResolvedValue(['/Users/me/shot.png'])
        mocks.clipboardHasImage.mockResolvedValue(hasImage)
        const insertTypedText = vi.fn(() => true)
        const setNotice = vi.fn()
        const probe = await renderProbe({
          resolveAttachmentOwner: () => ({ kind: 'runtime' }),
          insertTypedText,
          setNotice
        })
        await act(async () => probe.latest().pasteFromClipboard())
        expect(insertTypedText).toHaveBeenCalledTimes(inserts)
        expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toHaveLength(notices)
      }
    )
  })
})
