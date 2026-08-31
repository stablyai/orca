import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { CloneTask } from '@/store/slices/clone-tasks'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  refValues: [] as unknown[],
  refIndex: 0,
  storeState: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    cloneTasksById: {} as Record<string, CloneTask>,
    startCloneTask: vi.fn(),
    backgroundCloneTask: vi.fn(),
    dismissCloneTask: vi.fn()
  },
  pickDirectory: vi.fn(),
  onGitRepoReady: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = mocks.refIndex++
      return {
        current: index in mocks.refValues ? (mocks.refValues[index] as T) : value
      }
    },
    useState: <T>(initial: T | (() => T)) => {
      const index = mocks.stateIndex++
      const value =
        index in mocks.stateValues
          ? mocks.stateValues[index]
          : typeof initial === 'function'
            ? (initial as () => T)()
            : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value as T, setter]
    }
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
    {
      getState: () => mocks.storeState,
      setState: (next: Partial<typeof mocks.storeState>) => {
        Object.assign(mocks.storeState, next)
      }
    }
  )
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-cloned',
    path: '/srv/orca',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('useAddRepoCloneFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.refIndex = 0
    mocks.refValues = []
    // [cloneUrl, cloneDestination, cloneError, activeTaskId]
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '/srv', null, null]
    mocks.storeState.cloneTasksById = {}
    mocks.storeState.settings.activeRuntimeEnvironmentId = null
    mocks.storeState.startCloneTask.mockReturnValue('task-1')
    vi.stubGlobal('window', {
      api: { repos: { pickDirectory: mocks.pickDirectory } }
    })
  })

  it('starts an SSH-backed clone task through the store', async () => {
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: 'ssh-1',
      workspaceDir: '/local/workspace',
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.storeState.startCloneTask).toHaveBeenCalledWith({
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv',
      backend: 'ssh',
      connectionId: 'ssh-1',
      environmentId: undefined
    })
  })

  it('starts an environment-backed clone task when a runtime environment is active', async () => {
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: 'env-1',
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.storeState.startCloneTask).toHaveBeenCalledWith({
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv',
      backend: 'environment',
      connectionId: undefined,
      environmentId: 'env-1'
    })
  })

  it('starts a local clone task with no host qualifiers', async () => {
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.storeState.startCloneTask).toHaveBeenCalledWith({
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv',
      backend: 'local',
      connectionId: undefined,
      environmentId: undefined
    })
  })

  it('surfaces the task error and navigates on task success', async () => {
    const repo = makeRepo()
    // Active task points at a succeeded task; the success effect should navigate.
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '/srv', null, 'task-1']
    mocks.storeState.cloneTasksById = {
      'task-1': {
        id: 'task-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/srv',
        displayName: 'orca',
        backend: 'local',
        status: 'success',
        repoId: repo.id,
        backgrounded: false,
        startedAt: 1
      }
    }
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      onGitRepoReady: mocks.onGitRepoReady
    })

    // The success effect runs synchronously (mocked useEffect); its async body resolves next tick.
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'clone_url')
  })

  it('does not prefill SSH clone destinations from the local workspace directory', async () => {
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '', null, null]
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: 'ssh-1',
      workspaceDir: '/private/tmp/orca-setup-e2e.hOWO1f',
      onGitRepoReady: mocks.onGitRepoReady
    })

    expect(result.cloneDestination).toBe('')
    expect(mocks.stateSetters[1]).not.toHaveBeenCalledWith('/private/tmp/orca-setup-e2e.hOWO1f')
  })

  it('backgrounds the active task when the flow resets', async () => {
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '/srv', null, 'task-1']
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      onGitRepoReady: mocks.onGitRepoReady
    })
    result.resetCloneFlow()

    expect(mocks.storeState.backgroundCloneTask).toHaveBeenCalledWith('task-1')
  })
})
