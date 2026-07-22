// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'

const mocks = vi.hoisted(() => ({
  resolveNativeChatAttachmentOwner: vi.fn(),
  uploadNativeChatAttachmentPaths: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

vi.mock('./native-chat-attachment-upload', () => ({
  resolveNativeChatAttachmentOwner: mocks.resolveNativeChatAttachmentOwner,
  uploadNativeChatAttachmentPaths: mocks.uploadNativeChatAttachmentPaths,
  nativeChatWorktreeNotReadyNotice: () => 'Worktree not ready — try again in a moment.'
}))

import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'

type HookApi = ReturnType<typeof useNativeChatExternalAttachments>

function Probe({
  disabled,
  attachResolvedPaths,
  setNotice,
  onReady
}: {
  disabled: boolean
  attachResolvedPaths: (paths: string[]) => void
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}): null {
  onReady(
    useNativeChatExternalAttachments({
      terminalTabId: 'tab-1',
      disabled,
      attachResolvedPaths,
      setNotice
    })
  )
  return null
}

let root: Root | null = null

async function renderProbe(args: {
  disabled?: boolean
  attachResolvedPaths: (paths: string[]) => void
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
          attachResolvedPaths: args.attachResolvedPaths,
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

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatExternalAttachments', () => {
  it('attaches local worktree paths unchanged', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/local/a.txt'])
    expect(mocks.uploadNativeChatAttachmentPaths).not.toHaveBeenCalled()
  })

  it('uploads SSH worktree paths and attaches the remote results', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    mocks.uploadNativeChatAttachmentPaths.mockResolvedValue(['/remote/wt/.orca/drops/a.txt'])
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(mocks.uploadNativeChatAttachmentPaths).toHaveBeenCalledWith(['/local/a.txt'], {
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/remote/wt/.orca/drops/a.txt'])
  })

  it('shows the not-ready notice instead of attaching unresolved paths', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'not-ready' })
    const attachResolvedPaths = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths, setNotice })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(setNotice).toHaveBeenCalledWith('Worktree not ready — try again in a moment.')
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('drops an upload that resolves after the composer became disabled', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    let resolveUpload: (paths: string[]) => void = () => {}
    mocks.uploadNativeChatAttachmentPaths.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveUpload = resolve
      })
    )
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    await probe.setDisabled(true)
    await act(async () => {
      resolveUpload(['/remote/wt/.orca/drops/a.txt'])
    })
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })
})
