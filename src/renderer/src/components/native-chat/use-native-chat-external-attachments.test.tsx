// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'

const mocks = vi.hoisted(() => ({
  grantExternalFile: vi.fn(),
  grantExternalDirectory: vi.fn(),
  resolveNativeChatAttachmentOwner: vi.fn(),
  resolveNativeChatAttachmentOwnerForWorktree: vi.fn(),
  uploadNativeChatAttachmentPaths: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

// Real notice strings, so the tests below assert what a user would actually read
// and a newly added notice cannot go missing from this mock.
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploadModule>()),
  resolveNativeChatAttachmentOwner: mocks.resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree: mocks.resolveNativeChatAttachmentOwnerForWorktree,
  uploadNativeChatAttachmentPaths: mocks.uploadNativeChatAttachmentPaths
}))

import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'

type HookApi = ReturnType<typeof useNativeChatExternalAttachments>

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function Probe({
  disabled,
  structuredWorktreeId,
  attachResolvedPaths,
  setNotice,
  onReady
}: {
  disabled: boolean
  structuredWorktreeId?: string
  attachResolvedPaths: (paths: string[]) => void
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}): null {
  onReady(
    useNativeChatExternalAttachments({
      terminalTabId: 'tab-1',
      structuredWorktreeId,
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
  structuredWorktreeId?: string
  attachResolvedPaths: (paths: string[]) => void
  setNotice?: (notice: string | null) => void
}): Promise<{
  latest: () => HookApi
  setDisabled: (disabled: boolean) => Promise<void>
  setStructuredWorktreeId: (structuredWorktreeId: string) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: HookApi | null = null
  root = createRoot(container)
  let disabled = args.disabled ?? false
  let structuredWorktreeId = args.structuredWorktreeId
  const render = async (): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          disabled,
          structuredWorktreeId,
          attachResolvedPaths: args.attachResolvedPaths,
          setNotice: args.setNotice ?? (() => {}),
          onReady: (next) => {
            api = next
          }
        })
      )
    })
  }
  await render()
  return {
    latest: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    setDisabled: async (next) => {
      disabled = next
      await render()
    },
    setStructuredWorktreeId: async (next) => {
      structuredWorktreeId = next
      await render()
    }
  }
}

beforeEach(() => {
  mocks.grantExternalFile.mockReset().mockResolvedValue(undefined)
  mocks.grantExternalDirectory.mockReset().mockRejectedValue(new Error('not a directory'))
  mocks.resolveNativeChatAttachmentOwnerForWorktree.mockReset().mockReturnValue({ kind: 'local' })
  window.api = {
    fs: {
      grantExternalFile: mocks.grantExternalFile,
      grantExternalDirectory: mocks.grantExternalDirectory
    }
  } as unknown as Window['api']
})

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
    expect(mocks.grantExternalFile).toHaveBeenCalledExactlyOnceWith({
      targetPath: '/local/a.txt'
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/local/a.txt'])
    expect(mocks.uploadNativeChatAttachmentPaths).not.toHaveBeenCalled()
  })

  it('waits for local authorization and skips rejected paths without blocking other files', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const authorization = deferred<void>()
    mocks.grantExternalFile
      .mockReturnValueOnce(authorization.promise)
      .mockRejectedValueOnce(new Error('denied'))
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    act(() =>
      probe.latest().attachExternalPaths(['/external/a.png', '/external/b.png', '/external/c.png'])
    )
    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(mocks.grantExternalFile).toHaveBeenCalledTimes(1)
    await act(async () => authorization.resolve())
    expect(attachResolvedPaths).toHaveBeenCalledExactlyOnceWith([
      '/external/a.png',
      '/external/c.png'
    ])
    expect(mocks.grantExternalFile).toHaveBeenCalledTimes(3)
  })

  it('does not attach local paths when disabled during authorization', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const authorization = deferred<void>()
    mocks.grantExternalFile.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    act(() => probe.latest().attachExternalPaths(['/external/a.png', '/external/b.png']))
    await probe.setDisabled(true)
    await act(async () => authorization.resolve())
    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(mocks.grantExternalFile).toHaveBeenCalledTimes(1)
  })

  it('does not attach local paths when the owner changes during authorization', async () => {
    const authorization = deferred<void>()
    let owner: { kind: 'local' } | { kind: 'runtime' } = { kind: 'local' }
    mocks.resolveNativeChatAttachmentOwner.mockImplementation(() => owner)
    mocks.grantExternalFile.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/a.png', '/external/b.png']))
    owner = { kind: 'runtime' }
    await act(async () => authorization.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(mocks.grantExternalFile).toHaveBeenCalledTimes(1)
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // The owner flipping during the LAST path has no next iteration to catch it,
  // so the post-loop check is the only thing standing between a one-file drop
  // and a path attached to a host that no longer owns it.
  it('reports a one-file drop whose owner changes during its authorization', async () => {
    const authorization = deferred<void>()
    let owner: { kind: 'local' } | { kind: 'runtime' } = { kind: 'local' }
    mocks.resolveNativeChatAttachmentOwner.mockImplementation(() => owner)
    mocks.grantExternalFile.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/only.pdf']))
    owner = { kind: 'runtime' }
    await act(async () => authorization.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // Both workspaces answer `local`, so the owner alone cannot tell them apart:
  // only asking which workspace this composer serves now catches a tab that
  // moved while the authorization was still in flight.
  it('does not attach when the pane changes workspace during authorization', async () => {
    const authorization = deferred<void>()
    mocks.grantExternalFile.mockReturnValueOnce(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      structuredWorktreeId: 'worktree-1',
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/only.pdf']))
    await probe.setStructuredWorktreeId('worktree-2')
    await act(async () => authorization.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // The upload window is the long one: the paths go to the remote worktree the
  // attach captured, so a pane that moved workspaces meanwhile must not receive
  // remote paths that live under the workspace it left.
  it('does not attach uploaded paths when the pane changes workspace during upload', async () => {
    const sshOwner = {
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    } as const
    mocks.resolveNativeChatAttachmentOwnerForWorktree.mockReturnValue(sshOwner)
    const upload = deferred<string[]>()
    mocks.uploadNativeChatAttachmentPaths.mockReturnValueOnce(upload.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      structuredWorktreeId: 'worktree-1',
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/local/a.txt']))
    await probe.setStructuredWorktreeId('worktree-2')
    await act(async () => upload.resolve(['/remote/wt/.orca/drops/a.txt']))

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
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
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/remote/wt/.orca/drops/a.txt'], 'conn-1')
    expect(mocks.grantExternalFile).not.toHaveBeenCalled()
  })

  it('delivers concurrent SSH resolutions in order without deduplicating paths', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    const firstUpload = deferred<string[]>()
    const secondUpload = deferred<string[]>()
    mocks.uploadNativeChatAttachmentPaths
      .mockReturnValueOnce(firstUpload.promise)
      .mockReturnValueOnce(secondUpload.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })

    act(() => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
      probe.latest().attachExternalPaths(['/local/b.txt'])
    })
    await act(async () => {
      secondUpload.resolve(['/remote/wt/.orca/drops/b.txt', '/remote/wt/.orca/drops/b.txt'])
    })
    await act(async () => {
      firstUpload.resolve(['/remote/wt/.orca/drops/a.txt'])
    })

    expect(attachResolvedPaths.mock.calls).toEqual([
      [['/remote/wt/.orca/drops/b.txt', '/remote/wt/.orca/drops/b.txt'], 'conn-1'],
      [['/remote/wt/.orca/drops/a.txt'], 'conn-1']
    ])
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

  it('does not attach client-local paths to a remote runtime', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'runtime' })
    const attachResolvedPaths = vi.fn()
    const setNotice = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths, setNotice })
    await act(async () => {
      probe.latest().attachExternalPaths(['/local/a.txt'])
    })
    expect(setNotice).toHaveBeenCalledWith(
      'Local attachments are not available for remote sessions.'
    )
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('ignores local attachment insertion while already disabled', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ disabled: true, attachResolvedPaths })

    act(() => probe.latest().attachExternalPaths(['/local/a.txt']))

    expect(mocks.resolveNativeChatAttachmentOwner).not.toHaveBeenCalled()
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

  it('drops an upload that resolves after the SSH owner generation changes', async () => {
    const initialOwner = {
      kind: 'ssh' as const,
      connectionId: 'conn-1',
      worktreePath: '/remote/wt',
      expectedExecutionHostId: 'ssh:conn-1' as const,
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    }
    mocks.resolveNativeChatAttachmentOwner
      .mockReturnValueOnce(initialOwner)
      .mockReturnValue({ ...initialOwner, expectedSshConnectionGeneration: 5 })
    const upload = deferred<string[]>()
    mocks.uploadNativeChatAttachmentPaths.mockReturnValue(upload.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/local/a.txt']))
    await act(async () => upload.resolve(['/remote/wt/.orca/drops/a.txt']))

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })
})
