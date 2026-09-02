// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./native-chat-composer-target', () => ({
  NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES: 1024
}))

vi.mock('./native-chat-attachment-upload', () => ({
  nativeChatAttachmentHostChangedMessage: 'Attachment upload host changed; retry the attach.',
  nativeChatAttachmentOwnersMatch: (a: unknown, b: unknown) => a === b,
  nativeChatWorktreeNotReadyNotice: () => 'Worktree not ready — try again in a moment.'
}))

vi.stubGlobal('window', {
  api: {
    ui: {
      saveClipboardImageAsTempFile: mocks.saveClipboardImageAsTempFile,
      readClipboardText: mocks.readClipboardText
    }
  }
})

import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'

type HookApi = ReturnType<typeof useNativeChatComposerPaste>

function Probe({
  disabled,
  resolveAttachmentOwner,
  attachResolvedPaths,
  insertTypedText,
  setNotice,
  onReady
}: {
  disabled: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[]) => void
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}): null {
  onReady(
    useNativeChatComposerPaste({
      agent: 'claude',
      disabled,
      caret: 0,
      resolveAttachmentOwner,
      attachResolvedPaths,
      insertTypedText,
      setCaret: () => {},
      setNotice
    })
  )
  return null
}

let root: Root | null = null

async function renderProbe(args: {
  disabled?: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths?: (paths: string[]) => void
  insertTypedText?: (text: string) => boolean
  setNotice?: (notice: string | null) => void
}): Promise<{ latest: () => HookApi; setDisabled: (disabled: boolean) => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: HookApi | null = null
  root = createRoot(container)
  const render = async (disabled: boolean): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          disabled,
          resolveAttachmentOwner: args.resolveAttachmentOwner,
          attachResolvedPaths: args.attachResolvedPaths ?? (() => {}),
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
    clipboardData: { items: [{ type: 'image/png' }] } as unknown as DataTransfer,
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

const runtimeOwner: NativeChatAttachmentOwner = {
  kind: 'runtime',
  runtimeEnvironmentId: 'env-1',
  worktreeId: 'wt-1',
  worktreePath: '/srv/wt',
  connectionId: null,
  expectedExecutionHostId: 'local'
}

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatComposerPaste', () => {
  it('saves runtime-owned pastes on the runtime host and attaches the returned path', async () => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/orca-paste-remote.png')
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => runtimeOwner,
      attachResolvedPaths
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: null,
      runtimeEnvironmentId: 'env-1'
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/tmp/orca-paste-remote.png'])
  })

  it('drops a paste whose pane moved to a different host mid-save', async () => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/orca-paste-remote.png')
    const attachResolvedPaths = vi.fn()
    const setNotice = vi.fn()
    // First resolution captures the owner; the post-save re-resolution returns
    // a different owner object (reference inequality = host changed).
    const resolveAttachmentOwner = vi
      .fn<() => NativeChatAttachmentOwner>()
      .mockReturnValueOnce(runtimeOwner)
      .mockReturnValue({ ...runtimeOwner, runtimeEnvironmentId: 'env-2' })
    const probe = await renderProbe({
      resolveAttachmentOwner,
      attachResolvedPaths,
      setNotice
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith('Attachment upload host changed; retry the attach.')
  })

  it('passes the server-owned connection for nested runtime worktrees', async () => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/orca-paste-jetson.png')
    const attachResolvedPaths = vi.fn()
    const nestedOwner: NativeChatAttachmentOwner = { ...runtimeOwner, connectionId: 'conn-1' }
    const probe = await renderProbe({
      resolveAttachmentOwner: () => nestedOwner,
      attachResolvedPaths
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      runtimeEnvironmentId: 'env-1'
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/tmp/orca-paste-jetson.png'])
  })

  it('surfaces a failed SSH image save through the composer notice', async () => {
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(
      new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
    )
    const attachResolvedPaths = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => sshOwner,
      attachResolvedPaths,
      setNotice
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(setNotice).toHaveBeenCalledWith(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('saves on the SSH host and attaches the returned remote path', async () => {
    mocks.saveClipboardImageAsTempFile.mockResolvedValue('/remote/tmp/orca-paste-1.png')
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => sshOwner,
      attachResolvedPaths
    })
    await act(async () => {
      probe.latest().handlePaste(imagePasteEvent())
    })
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({ connectionId: 'conn-1' })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/remote/tmp/orca-paste-1.png'])
  })

  it('stops pasteFromClipboard on a failed save instead of falling through to text', async () => {
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
    mocks.saveClipboardImageAsTempFile.mockResolvedValue(null)
    mocks.readClipboardText.mockResolvedValue('hello')
    const insertTypedText = vi.fn()
    const probe = await renderProbe({
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      insertTypedText
    })
    await act(async () => {
      probe.latest().pasteFromClipboard()
    })
    expect(insertTypedText).toHaveBeenCalledWith('hello')
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
