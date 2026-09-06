// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mocks = vi.hoisted(() => ({
  resolveNativeChatAttachmentOwner: vi.fn(),
  uploadNativeChatAttachmentPaths: vi.fn(),
  authorizeExternalPath: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

vi.mock('./native-chat-attachment-upload', () => ({
  nativeChatLocalAttachmentUnsupportedNotice: () =>
    'Local attachments are not available for remote sessions.',
  resolveNativeChatAttachmentOwner: mocks.resolveNativeChatAttachmentOwner,
  uploadNativeChatAttachmentPaths: mocks.uploadNativeChatAttachmentPaths,
  nativeChatWorktreeNotReadyNotice: () => 'Worktree not ready — try again in a moment.'
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

beforeEach(() => {
  mocks.authorizeExternalPath.mockResolvedValue(undefined)
  window.api = {
    fs: { authorizeExternalPath: mocks.authorizeExternalPath }
  } as unknown as Window['api']
})

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatExternalAttachments', () => {
  it('authorizes local paths before attaching so preview can read files outside allowed roots', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/tmp/logo.png', '/tmp/shot.png'])
    })
    expect(mocks.authorizeExternalPath.mock.calls).toEqual([
      [{ targetPath: '/tmp/logo.png' }],
      [{ targetPath: '/tmp/shot.png' }]
    ])
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/tmp/logo.png', '/tmp/shot.png'])
    expect(mocks.uploadNativeChatAttachmentPaths).not.toHaveBeenCalled()
  })

  it('does not attach local paths until authorize resolves', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const authorization = deferred<void>()
    mocks.authorizeExternalPath.mockReturnValue(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })

    act(() => {
      probe.latest().attachExternalPaths(['/tmp/logo.png'])
    })
    expect(attachResolvedPaths).not.toHaveBeenCalled()

    await act(async () => {
      authorization.resolve(undefined)
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/tmp/logo.png'])
  })

  it('drops a local authorize that resolves after the composer became disabled', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const authorization = deferred<void>()
    mocks.authorizeExternalPath.mockReturnValue(authorization.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })

    act(() => {
      probe.latest().attachExternalPaths(['/tmp/logo.png'])
    })
    await probe.setDisabled(true)
    await act(async () => {
      authorization.resolve(undefined)
    })
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('delivers concurrent local authorizations in completion order', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    const firstAuth = deferred<void>()
    const secondAuth = deferred<void>()
    mocks.authorizeExternalPath
      .mockReturnValueOnce(firstAuth.promise)
      .mockReturnValueOnce(secondAuth.promise)
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })

    act(() => {
      probe.latest().attachExternalPaths(['/tmp/a.png'])
      probe.latest().attachExternalPaths(['/tmp/b.png'])
    })
    await act(async () => {
      secondAuth.resolve(undefined)
    })
    await act(async () => {
      firstAuth.resolve(undefined)
    })

    expect(attachResolvedPaths.mock.calls).toEqual([[['/tmp/b.png']], [['/tmp/a.png']]])
  })

  it('still attaches when local authorize rejects so send is not blocked by preview grant', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'local' })
    mocks.authorizeExternalPath.mockRejectedValue(new Error('authorize failed'))
    const attachResolvedPaths = vi.fn()
    const probe = await renderProbe({ attachResolvedPaths })
    await act(async () => {
      probe.latest().attachExternalPaths(['/tmp/logo.png'])
    })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['/tmp/logo.png'])
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
    expect(mocks.authorizeExternalPath).not.toHaveBeenCalled()
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
})
