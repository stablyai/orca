// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
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

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatComposerPaste', () => {
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
