import { afterEach, beforeEach, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '@/store/repos/repo-state'
import type { Repo } from '../../../../shared/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Worktree
} from '../../../../shared/worktree/types'
const mocks = vi.hoisted(() => {
  const data: {
    activeRepoId: string | null
    filterRepoIds: string[]
    repos: Repo[]
    worktreesByRepo: Record<string, Worktree[]>
    detectedWorktreesByRepo: Record<string, DetectedWorktreeListResult>
  } = {
    activeRepoId: null,
    filterRepoIds: [],
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {}
  }
  return {
    state: {
      ...data,
      showActiveOnly: false,
      hideDefaultBranchWorkspace: false,
      setActiveRepo: vi.fn(),
      setFilterRepoIds: vi.fn(),
      setShowActiveOnly: vi.fn(),
      setHideDefaultBranchWorkspace: vi.fn(),
      updateRepo: vi.fn(),
      fetchWorktrees: vi.fn()
    },
    activateAndRevealWorktree: vi.fn(),
    onboardingGet: vi.fn(),
    onboardingUpdate: vi.fn(),
    track: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

export function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

export function makeLinkedWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: 'repo-1::/repo-feature',
    path: '/repo-feature',
    displayName: 'feature',
    branch: 'refs/heads/feature',
    isMainWorktree: false,
    ...overrides
  })
}

export function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

export function makeDetectedLinkedWorktrees(
  defaultCheckout: Worktree,
  options: { linkedVisible?: boolean; linkedOwnership?: DetectedWorktree['ownership'] } = {}
): DetectedWorktreeListResult {
  const linkedVisible = options.linkedVisible ?? false
  return {
    repoId: 'repo-1',
    authoritative: true,
    source: 'git',
    worktrees: [
      {
        ...defaultCheckout,
        ownership: 'external',
        selectedCheckout: true,
        visible: true
      },
      {
        ...makeLinkedWorktree(),
        ownership: options.linkedOwnership ?? 'external',
        selectedCheckout: false,
        visible: linkedVisible
      }
    ]
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.activeRepoId = null
  mocks.state.filterRepoIds = []
  mocks.state.showActiveOnly = false
  mocks.state.hideDefaultBranchWorkspace = false
  mocks.state.repos = []
  mocks.state.worktreesByRepo = {}
  mocks.state.detectedWorktreesByRepo = {}
  mocks.state.updateRepo.mockImplementation(
    async (
      repoId: string,
      updates: Parameters<RepoSlice['updateRepo']>[1],
      options?: Parameters<RepoSlice['updateRepo']>[2]
    ) => {
      mocks.state.repos = mocks.state.repos.map((repo) => {
        if (repo.id !== repoId || getRepoExecutionHostId(repo) !== options?.hostId) {
          return repo
        }
        const applied = typeof updates === 'function' ? updates(repo) : updates
        return {
          ...repo,
          importedExternalWorktreePaths:
            applied.importedExternalWorktreePaths ?? repo.importedExternalWorktreePaths,
          externalWorktreeVisibilityPromptDismissedAt:
            applied.externalWorktreeVisibilityPromptDismissedAt ??
            repo.externalWorktreeVisibilityPromptDismissedAt
        }
      })
      return true
    }
  )
  mocks.state.fetchWorktrees.mockResolvedValue(true)
  mocks.onboardingGet.mockResolvedValue(getDefaultOnboardingState())
  mocks.onboardingUpdate.mockResolvedValue(getDefaultOnboardingState())
  vi.stubGlobal('window', {
    api: {
      onboarding: {
        get: mocks.onboardingGet,
        update: mocks.onboardingUpdate
      }
    }
  })
})

export { mocks }
