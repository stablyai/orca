import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateIndex: 0,
  refValues: [] as { current: unknown }[],
  refIndex: 0,
  browseRuntimeServerDirectory: vi.fn(),
  callRuntimeRpc: vi.fn(),
  isGitAvailable: vi.fn(),
  getDefaultCreateProjectParent: vi.fn(),
  sshBrowseDir: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useRef: <T>(value: T) => {
      const index = mocks.refIndex++
      if (!(index in mocks.refValues)) {
        mocks.refValues[index] = { current: value }
      }
      return mocks.refValues[index] as { current: T }
    },
    useEffect: (effect: () => void | (() => void)) => {
      void effect()
    },
    useState: <T>(initial: T) => {
      const index = mocks.stateIndex++
      if (!(index in mocks.stateValues)) {
        mocks.stateValues[index] = initial
      }
      const setter = (value: T) => {
        mocks.stateValues[index] = value
      }
      return [mocks.stateValues[index] as T, setter]
    }
  }
})

vi.mock('@/runtime/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: mocks.browseRuntimeServerDirectory
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

import { useCreateProjectDefaults } from './useCreateProjectDefaults'

// State order inside the hook: [defaultParent, gitAvailability, runtimeParentStatus].
const DEFAULT_PARENT_STATE = 0
const GIT_AVAILABILITY_STATE = 1
const RUNTIME_PARENT_STATUS_STATE = 2
// Ref order inside the hook: [autoFilled marker, autoFilledParent, provenance, ...].
const PROVENANCE_REF = 2

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function useHarness(overrides: Partial<Parameters<typeof useCreateProjectDefaults>[0]> = {}) {
  mocks.stateIndex = 0
  mocks.refIndex = 0
  const setCreateParent = vi.fn()
  const result = useCreateProjectDefaults({
    step: 'create',
    activeRuntimeEnvironmentId: null,
    createParent: '',
    setCreateParent,
    ...overrides
  })
  return { result, setCreateParent }
}

describe('useCreateProjectDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateValues = []
    mocks.stateIndex = 0
    mocks.refValues = []
    mocks.refIndex = 0
    vi.stubGlobal('window', {
      api: {
        repos: {
          isGitAvailable: mocks.isGitAvailable,
          getDefaultCreateProjectParent: mocks.getDefaultCreateProjectParent
        },
        ssh: {
          browseDir: mocks.sshBrowseDir
        }
      }
    })
    mocks.getDefaultCreateProjectParent.mockResolvedValue('/Users/alice/orca/projects')
  })

  it('auto-fills the local default parent and reports Git availability', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)

    const { setCreateParent } = useHarness()
    await flushAsync()

    expect(setCreateParent).toHaveBeenCalledWith('/Users/alice/orca/projects')
    expect(mocks.stateValues[DEFAULT_PARENT_STATE]).toBe('/Users/alice/orca/projects')
    expect(mocks.stateValues[GIT_AVAILABILITY_STATE]).toBe('available')
    expect(mocks.getDefaultCreateProjectParent).toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('auto-fills the local home default regardless of workspace directory settings', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)

    const { setCreateParent } = useHarness()
    await flushAsync()

    expect(mocks.getDefaultCreateProjectParent).toHaveBeenCalled()
    expect(setCreateParent).toHaveBeenCalledWith('/Users/alice/orca/projects')
    expect(mocks.stateValues[DEFAULT_PARENT_STATE]).toBe('/Users/alice/orca/projects')
  })

  it('keeps the local default marker after the auto-filled parent rerenders the hook', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)

    useHarness()
    await flushAsync()
    useHarness({ createParent: '/Users/alice/orca/projects' })

    expect(mocks.stateValues[DEFAULT_PARENT_STATE]).toBe('/Users/alice/orca/projects')
  })

  it('reports unavailable Git without changing the fixed project kind', async () => {
    mocks.isGitAvailable.mockResolvedValue(false)

    useHarness()
    await flushAsync()

    expect(mocks.stateValues[GIT_AVAILABILITY_STATE]).toBe('unavailable')
  })

  it('reports unknown availability when the Git probe fails', async () => {
    mocks.isGitAvailable.mockRejectedValue(new Error('probe failed'))

    useHarness()
    await flushAsync()

    expect(mocks.stateValues[GIT_AVAILABILITY_STATE]).toBe('unknown')
  })

  it('does not overwrite a parent the user already chose', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)

    const { setCreateParent } = useHarness({ createParent: '/tmp/custom' })
    await flushAsync()

    expect(setCreateParent).not.toHaveBeenCalled()
  })

  it('resolves the runtime default parent from the host home directory', async () => {
    mocks.browseRuntimeServerDirectory.mockResolvedValue({ resolvedPath: '/home/alice' })
    mocks.callRuntimeRpc.mockResolvedValue({ available: true })

    const { setCreateParent } = useHarness({ activeRuntimeEnvironmentId: 'env-1' })
    await flushAsync()

    expect(mocks.browseRuntimeServerDirectory).toHaveBeenCalledWith('env-1', '~')
    expect(setCreateParent).toHaveBeenCalledWith('/home/alice/orca/projects')
    expect(mocks.stateValues[DEFAULT_PARENT_STATE]).toBe('/home/alice/orca/projects')
    expect(mocks.stateValues[RUNTIME_PARENT_STATUS_STATE]).toBe('idle')
    // Why: runtime Git availability must be probed on the host, not the client.
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'repo.gitAvailable',
      undefined,
      { timeoutMs: 3000 }
    )
    expect(mocks.isGitAvailable).not.toHaveBeenCalled()
  })

  it('replaces an untouched local default when switching to a runtime target', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)
    mocks.browseRuntimeServerDirectory.mockResolvedValue({ resolvedPath: '/home/alice' })
    mocks.callRuntimeRpc.mockResolvedValue({ available: true })

    const local = useHarness()
    await flushAsync()
    expect(local.setCreateParent).toHaveBeenCalledWith('/Users/alice/orca/projects')

    const runtime = useHarness({
      activeRuntimeEnvironmentId: 'env-1',
      createParent: '/Users/alice/orca/projects'
    })

    expect(runtime.result.createParentDefaultPending).toBe(true)
    expect(runtime.setCreateParent).toHaveBeenCalledWith('')
    expect(mocks.stateValues[RUNTIME_PARENT_STATUS_STATE]).toBe('checking')
    expect(mocks.browseRuntimeServerDirectory).not.toHaveBeenCalled()

    const resolvedRuntime = useHarness({
      activeRuntimeEnvironmentId: 'env-1',
      createParent: ''
    })
    await flushAsync()

    expect(mocks.browseRuntimeServerDirectory).toHaveBeenCalledWith('env-1', '~')
    expect(resolvedRuntime.setCreateParent).toHaveBeenCalledWith('/home/alice/orca/projects')
    expect(mocks.stateValues[DEFAULT_PARENT_STATE]).toBe('/home/alice/orca/projects')
    expect(resolvedRuntime.result.createParentDefaultPending).toBe(false)
  })

  it('does not replace a touched parent when switching to a runtime target', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)
    mocks.browseRuntimeServerDirectory.mockResolvedValue({ resolvedPath: '/home/alice' })
    mocks.callRuntimeRpc.mockResolvedValue({ available: true })

    const local = useHarness({ createParent: '/Users/alice/orca/projects' })
    local.result.markCreateParentTouched('/Users/alice/orca/projects/pr5115-target-switch')

    const runtime = useHarness({
      activeRuntimeEnvironmentId: 'env-1',
      createParent: '/Users/alice/orca/projects/pr5115-target-switch'
    })
    await flushAsync()

    expect(runtime.result.createParentDefaultPending).toBe(true)
    expect(mocks.browseRuntimeServerDirectory).not.toHaveBeenCalled()
    expect(runtime.setCreateParent).not.toHaveBeenCalled()

    runtime.result.markCreateParentTouched('/home/alice/projects')
    const runtimeEdited = useHarness({
      activeRuntimeEnvironmentId: 'env-1',
      createParent: '/home/alice/projects'
    })

    expect(runtimeEdited.result.createParentDefaultPending).toBe(false)
  })

  it('marks the runtime parent lookup failed without filling a parent', async () => {
    mocks.browseRuntimeServerDirectory.mockRejectedValue(new Error('disconnected'))
    mocks.callRuntimeRpc.mockResolvedValue({ available: true })

    const { setCreateParent } = useHarness({ activeRuntimeEnvironmentId: 'env-1' })
    await flushAsync()

    expect(mocks.stateValues[RUNTIME_PARENT_STATUS_STATE]).toBe('failed')
    expect(setCreateParent).not.toHaveBeenCalled()
  })

  it('resolves the SSH default parent from the host home without client probing', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)
    mocks.sshBrowseDir.mockResolvedValue({ entries: [], resolvedPath: '/home/alice' })

    const { setCreateParent } = useHarness({ sshTargetId: 'ssh-1' })
    await flushAsync()

    expect(mocks.sshBrowseDir).toHaveBeenCalledWith({ targetId: 'ssh-1', dirPath: '~' })
    expect(setCreateParent).toHaveBeenCalledWith('/home/alice/orca/projects')
    expect(mocks.stateValues[DEFAULT_PARENT_STATE]).toBe('/home/alice/orca/projects')
    expect(mocks.stateValues[RUNTIME_PARENT_STATUS_STATE]).toBe('idle')
    // Why: SSH creation runs on the host relay, so client Git and local/runtime
    // parent lookups must stay untouched and Git availability stays unknown.
    expect(mocks.stateValues[GIT_AVAILABILITY_STATE]).toBe('unknown')
    expect(mocks.getDefaultCreateProjectParent).not.toHaveBeenCalled()
    expect(mocks.isGitAvailable).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    // Provenance is recorded so a later target switch can detect the stale value.
    expect(mocks.refValues[PROVENANCE_REF].current).toEqual({
      parent: '/home/alice/orca/projects',
      targetKey: 'ssh:ssh-1'
    })
  })

  it('marks the SSH parent lookup failed without filling a parent', async () => {
    mocks.sshBrowseDir.mockRejectedValue(new Error('disconnected'))

    const { setCreateParent } = useHarness({ sshTargetId: 'ssh-1' })
    await flushAsync()

    expect(mocks.stateValues[RUNTIME_PARENT_STATUS_STATE]).toBe('failed')
    expect(setCreateParent).not.toHaveBeenCalled()
  })

  it('does not replace a touched parent with the SSH default', async () => {
    mocks.sshBrowseDir.mockResolvedValue({ entries: [], resolvedPath: '/home/alice' })

    const ssh = useHarness({ sshTargetId: 'ssh-1', createParent: '/home/alice/custom' })
    ssh.result.markCreateParentTouched('/home/alice/custom')

    const sshTouched = useHarness({ sshTargetId: 'ssh-1', createParent: '/home/alice/custom' })
    await flushAsync()

    expect(mocks.sshBrowseDir).not.toHaveBeenCalled()
    expect(sshTouched.setCreateParent).not.toHaveBeenCalled()
  })

  it('clears the stale SSH default when switching to a local target', async () => {
    mocks.isGitAvailable.mockResolvedValue(true)
    mocks.sshBrowseDir.mockResolvedValue({ entries: [], resolvedPath: '/home/alice' })

    const ssh = useHarness({ sshTargetId: 'ssh-1' })
    await flushAsync()
    expect(ssh.setCreateParent).toHaveBeenCalledWith('/home/alice/orca/projects')

    const local = useHarness({ createParent: '/home/alice/orca/projects' })

    expect(local.result.createParentDefaultPending).toBe(true)
    expect(local.setCreateParent).toHaveBeenCalledWith('')
  })

  it('does nothing outside the create step', async () => {
    const { setCreateParent } = useHarness({ step: 'add' })
    await flushAsync()

    expect(setCreateParent).not.toHaveBeenCalled()
    expect(mocks.isGitAvailable).not.toHaveBeenCalled()
    expect(mocks.browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })
})
