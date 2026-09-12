import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/repo-types'

// Guards Req: Provenance-Based Trust Defaults / A created repo is trusted immediately —
// `repos:create` writes trust in-process on the main side (see repo-creation-handlers.ts);
// the renderer create flow must never call the trust channel at all.
const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  storeState: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    repos: [] as Repo[],
    projects: [],
    projectHostSetups: [],
    worktreesByRepo: {} as Record<string, unknown[]>
  },
  createRepo: vi.fn(),
  fetchWorktrees: vi.fn(),
  onGitRepoReady: vi.fn(),
  resolveIntake: vi.fn(),
  markOnboardingProjectAdded: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useRef: <T>(value: T) => ({ current: value }),
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

vi.mock('@/hooks/useMountedRef', () => ({ useMountedRef: () => ({ current: true }) }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: mocks.markOnboardingProjectAdded
}))
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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

const STATE_NAME = 0
const STATE_PARENT_PATH = 1

function makeRepo(): Repo {
  return {
    id: 'repo-created',
    path: '/projects/created',
    displayName: 'created',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git'
  }
}

describe('useCreateRepo — workspace trust boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = []
    mocks.stateValues[STATE_NAME] = 'created'
    mocks.stateValues[STATE_PARENT_PATH] = '/projects'
    mocks.storeState.repos = []
    mocks.storeState.projects = []
    mocks.storeState.projectHostSetups = []
    mocks.storeState.worktreesByRepo = {}
    vi.stubGlobal('window', {
      api: {
        repos: { create: mocks.createRepo, createRemote: vi.fn(), pickDirectory: vi.fn() },
        workspaceTrust: { resolveIntake: mocks.resolveIntake, decide: vi.fn() }
      }
    })
  })

  it('never calls the workspace trust channel during repos:create', async () => {
    const repo = makeRepo()
    mocks.createRepo.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useCreateRepo } = await import('./useCreateRepo')

    const result = useCreateRepo(mocks.fetchWorktrees, vi.fn(), mocks.onGitRepoReady)
    await result.handleCreate()

    expect(mocks.createRepo).toHaveBeenCalled()
    expect(mocks.resolveIntake).not.toHaveBeenCalled()
  })
})
