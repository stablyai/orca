// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn(),
  readClipboardImageThumbnail: vi.fn()
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
      readClipboardImageThumbnail: mocks.readClipboardImageThumbnail
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
  disabled?: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths?: (paths: string[], connectionId?: string | null) => void
  store?: ReturnType<typeof createChipStore>
  insertTypedText?: (text: string) => boolean
  setNotice?: (notice: string | null) => void
}): Promise<{ latest: () => HookApi; setDisabled: (disabled: boolean) => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const store = args.store ?? createChipStore()
  let api: HookApi | null = null
  root = createRoot(container)
  const render = async (disabled: boolean): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
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
    setDisabled: render
  }
}

function imagePasteEvent(): {
  clipboardData: DataTransfer
  preventDefault: () => void
  defaultPrevented: boolean
} {
  return {
    clipboardData: {
      items: [{ type: 'image/png', getAsFile: () => new Blob([], { type: 'image/png' }) }]
    } as unknown as DataTransfer,
    preventDefault: vi.fn(),
    defaultPrevented: false
  }
}

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

  it('stops pasteFromClipboard on a failed save instead of falling through to text', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue(null)
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(new Error('sftp down'))
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
    expect(mocks.readClipboardText).not.toHaveBeenCalled()
    expect(insertTypedText).not.toHaveBeenCalled()
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
    expect(setNotice).not.toHaveBeenCalled()
  })
})
