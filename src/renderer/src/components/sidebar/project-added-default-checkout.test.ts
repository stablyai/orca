import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '@/store/repos/repo-state'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import {
  finishProjectAddWithDefaultCheckout,
  getProjectDefaultCheckout,
  openProjectDefaultCheckout
} from './project-added-default-checkout'

const mocks = vi.hoisted(() => ({
  state: {
    activeRepoId: null as string | null,
    filterRepoIds: [] as string[],
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    repos: [] as Repo[],
    worktreesByRepo: {} as Record<string, Worktree[]>,
    detectedWorktreesByRepo: {} as Record<string, DetectedWorktreeListResult>,
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
}))

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

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
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

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function makeFeatureWorktree(): Worktree {
  return makeWorktree({
    id: 'repo-1::/repo-feature',
    path: '/repo-feature',
    displayName: 'feature',
    branch: 'refs/heads/feature',
    isMainWorktree: false
  })
}

function makeDetectedLinkedWorktrees(defaultCheckout: Worktree): DetectedWorktreeListResult {
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
        ...makeWorktree({
          id: 'repo-1::/repo-feature',
          path: '/repo-feature',
          displayName: 'feature',
          branch: 'refs/heads/feature',
          isMainWorktree: false
        }),
        ownership: 'external',
        selectedCheckout: false,
        visible: false
      }
    ]
  }
}

describe('getProjectDefaultCheckout', () => {
  it('returns the main worktree rather than the first worktree', () => {
    const feature = makeWorktree({
      id: 'repo-1::/repo-feature',
      path: '/repo-feature',
      isMainWorktree: false
    })
    const main = makeWorktree()

    expect(getProjectDefaultCheckout([feature, main])).toBe(main)
  })

  it('prefers the checkout the project is registered at over the main worktree', () => {
    const feature = makeWorktree({
      id: 'repo-1::/repo-feature',
      path: '/repo-feature',
      isMainWorktree: false
    })
    const main = makeWorktree()

    expect(getProjectDefaultCheckout([main, feature], ['/repo-feature'])).toBe(feature)
  })

  it('prefers the deepest checkout containing the first matching anchor', () => {
    const main = makeWorktree()
    const nested = makeWorktree({
      id: 'repo-1::/repo/.worktrees/feat',
      path: '/repo/.worktrees/feat',
      isMainWorktree: false
    })
    const feature = makeFeatureWorktree()

    expect(getProjectDefaultCheckout([main, nested], ['/repo/.worktrees/feat/src'])).toBe(nested)
    expect(getProjectDefaultCheckout([main, feature], ['/elsewhere', '/repo-feature/src'])).toBe(
      feature
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
})

describe('finishProjectAddWithDefaultCheckout', () => {
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
              applied.importedExternalWorktreePaths ?? repo.importedExternalWorktreePaths
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

  it('closes the modal and activates the default checkout', async () => {
    const closeModal = vi.fn()
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      closeModal,
      setHideDefaultBranchWorkspace
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.onboardingUpdate).toHaveBeenCalledWith({
      checklist: { addedRepo: true }
    })
    expect(setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
    expect(mocks.track).toHaveBeenCalledWith('activation_checklist_item_completed', {
      item: 'addedRepo',
      time_since_completed_ms: 0
    })
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'clone_url',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('activates only the captured host default checkout when repo IDs collide', async () => {
    const localMain = makeWorktree({
      id: 'repo-1::same-id',
      path: '/local/repo',
      hostId: 'local'
    })
    const runtimeMain = makeWorktree({
      id: 'repo-1::same-id',
      path: '/runtime/repo',
      hostId: 'runtime:env-1'
    })
    mocks.state.repos = [
      {
        id: 'repo-1',
        path: '/local/repo',
        displayName: 'local',
        badgeColor: '#111',
        addedAt: 1,
        executionHostId: 'local'
      },
      {
        id: 'repo-1',
        path: '/runtime/repo',
        displayName: 'runtime',
        badgeColor: '#222',
        addedAt: 2,
        executionHostId: 'runtime:env-1'
      }
    ]
    mocks.state.worktreesByRepo = {
      'repo-1': [localMain, runtimeMain]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      executionHostId: 'runtime:env-1',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(runtimeMain.id, {
      executionHostId: 'runtime:env-1'
    })
  })

  it('activates a runtime-owned checkout even when its physical host is private SSH', async () => {
    const runtimeMain = makeWorktree({
      id: 'repo-1::runtime-ssh',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    mocks.state.worktreesByRepo = { 'repo-1': [runtimeMain] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'runtime_server_path',
      executionHostId: 'runtime:env-1',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(runtimeMain.id, {
      executionHostId: 'runtime:env-1'
    })
  })

  it('passes a contained selected path through as the initial terminal cwd', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo/packages/web',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      initialCwd: '/repo/packages/web'
    })
  })

  it('skips the initial cwd override when the selected path is the repo root', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('opens the linked checkout a project is registered at, not its hidden primary', async () => {
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.repos = [makeRepo({ path: '/repo-feature' })]
    mocks.state.worktreesByRepo = {
      'repo-1': [makeFeatureWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo-feature')
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_selected_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
  })

  it('prefers the registered linked checkout even when the primary is also visible', async () => {
    mocks.state.repos = [makeRepo({ path: '/repo-feature' })]
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree(), makeFeatureWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo-feature')
  })

  it('leaves hidden sibling worktrees hidden without touching repo settings', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('imports and opens a hidden linked checkout picked for an already-registered main project', async () => {
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.hideDefaultBranchWorkspace = true
    const primary = makeWorktree()
    const feature = makeFeatureWorktree()
    const sibling = makeWorktree({
      id: 'repo-1::/repo-other',
      path: '/repo-other',
      isMainWorktree: false
    })
    // Registration resolved the picked linked checkout to the existing main project row.
    mocks.state.repos = [makeRepo({ importedExternalWorktreePaths: ['/already-imported'] })]
    mocks.state.worktreesByRepo = { 'repo-1': [primary] }
    const detected = makeDetectedLinkedWorktrees(primary)
    detected.worktrees.push({
      ...sibling,
      ownership: 'external',
      selectedCheckout: false,
      visible: false
    })
    mocks.state.detectedWorktreesByRepo = { 'repo-1': detected }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = { 'repo-1': [primary, feature] }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo-feature',
      executionHostId: 'local',
      setHideDefaultBranchWorkspace
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'local'
    })
    // Only the picked checkout is imported; the hidden sibling stays behind the notice.
    expect(mocks.state.repos[0]?.importedExternalWorktreePaths).toEqual([
      '/already-imported',
      '/repo-feature'
    ])
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledExactlyOnceWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(feature.id, {
      executionHostId: 'local'
    })
    expect(setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_selected_checkout',
      reason: 'detected_default_checkout'
    })
  })

  it('opens a hidden linked checkout at the picked subdirectory', async () => {
    const primary = makeWorktree()
    const feature = makeFeatureWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = { 'repo-1': [primary] }
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetectedLinkedWorktrees(primary) }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = { 'repo-1': [primary, feature] }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo-feature/packages/web',
      executionHostId: 'local',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.repos[0]?.importedExternalWorktreePaths).toEqual(['/repo-feature'])
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(feature.id, {
      initialCwd: '/repo-feature/packages/web',
      executionHostId: 'local'
    })
  })

  it('imports the picked checkout into the owning host row when repo IDs collide', async () => {
    const sshPrimary = makeWorktree({ id: 'repo-1::ssh-main', hostId: 'ssh:box' })
    const sshFeatureWithHost = makeWorktree({
      ...makeFeatureWorktree(),
      id: 'repo-1::ssh-feature',
      hostId: 'ssh:box'
    })
    mocks.state.repos = [
      makeRepo({ executionHostId: 'local', importedExternalWorktreePaths: ['/local-only'] }),
      makeRepo({ executionHostId: 'ssh:box', importedExternalWorktreePaths: ['/ssh-only'] })
    ]
    mocks.state.worktreesByRepo = { 'repo-1': [makeWorktree({ hostId: 'local' }), sshPrimary] }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          { ...sshPrimary, ownership: 'external', selectedCheckout: true, visible: true },
          { ...sshFeatureWithHost, ownership: 'external', selectedCheckout: false, visible: false }
        ]
      }
    }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = {
        'repo-1': [makeWorktree({ hostId: 'local' }), sshPrimary, sshFeatureWithHost]
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'ssh_remote_path',
      selectedPath: '/repo-feature',
      executionHostId: 'ssh:box',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'ssh:box'
    })
    expect(mocks.state.repos.map((repo) => repo.importedExternalWorktreePaths)).toEqual([
      ['/local-only'],
      ['/ssh-only', '/repo-feature']
    ])
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'ssh:box'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(sshFeatureWithHost.id, {
      executionHostId: 'ssh:box'
    })
  })

  it('does not guess an owner row to import into when a bare repo ID has multiple hosts', async () => {
    const primary = makeWorktree()
    mocks.state.repos = [makeRepo(), makeRepo({ executionHostId: 'ssh:box' })]
    mocks.state.worktreesByRepo = { 'repo-1': [primary] }
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetectedLinkedWorktrees(primary) }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      selectedPath: '/repo-feature',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(primary.id)
  })

  it('opens an already-visible picked checkout without importing it', async () => {
    const primary = makeWorktree()
    const feature = makeFeatureWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = { 'repo-1': [primary, feature] }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        ...makeDetectedLinkedWorktrees(primary),
        worktrees: makeDetectedLinkedWorktrees(primary).worktrees.map((worktree) => ({
          ...worktree,
          visible: true
        }))
      }
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo-feature/src',
      executionHostId: 'local',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(feature.id, {
      initialCwd: '/repo-feature/src',
      executionHostId: 'local'
    })
  })

  it('reveals the project when importing the picked checkout fails', async () => {
    const primary = makeWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = { 'repo-1': [primary] }
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetectedLinkedWorktrees(primary) }
    mocks.state.updateRepo.mockResolvedValue(false)

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo-feature',
      executionHostId: 'local',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'revealed_project',
      reason: 'show_detected_default_failed'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
  })

  it('refreshes once when the checkout has not loaded yet', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = {
        'repo-1': [defaultCheckout]
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true
    })
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'detected_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('reveals the project if the refresh is not authoritative', async () => {
    mocks.state.fetchWorktrees.mockResolvedValue(false)

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'revealed_project',
      reason: 'authoritative_refresh_failed'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
  })

  it('reveals the project if no default checkout is available', async () => {
    const closeModal = vi.fn()
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ isMainWorktree: false })]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'ssh_remote_path',
      closeModal,
      setHideDefaultBranchWorkspace
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'ssh_remote_path',
      result: 'revealed_project',
      reason: 'refreshed_default_missing'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('reveals the project even when no worktrees are loaded', async () => {
    mocks.state.activeRepoId = 'repo-2'
    mocks.state.filterRepoIds = ['repo-2']
    mocks.state.showActiveOnly = true

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'project_added_compat',
      result: 'revealed_project',
      reason: 'refreshed_default_missing'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(mocks.state.setFilterRepoIds).toHaveBeenCalledWith(['repo-2', 'repo-1'])
    expect(mocks.state.setShowActiveOnly).toHaveBeenCalledWith(false)
  })
})
