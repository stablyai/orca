import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Worktree
} from '../../../../shared/worktree/types'
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
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
    repos: [] as Repo[],
    worktreesByRepo: {} as Record<string, Worktree[]>,
    detectedWorktreesByRepo: {} as Record<string, DetectedWorktreeListResult>,
    setActiveRepo: vi.fn(),
    setFilterRepoIds: vi.fn(),
    setShowActiveOnly: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setAlwaysShowDefaultBranchWorkspace: vi.fn(),
    revealSidebarRow: vi.fn(),
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn()
  },
  activateAndRevealWorktree: vi.fn(),
  toastWarning: vi.fn(),
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

vi.mock('sonner', () => ({
  toast: { warning: mocks.toastWarning }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
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

function makeDetectedLinkedWorktrees(
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
        ...makeWorktree({
          id: 'repo-1::/repo-feature',
          path: '/repo-feature',
          displayName: 'feature',
          branch: 'refs/heads/feature',
          isMainWorktree: false
        }),
        ownership: options.linkedOwnership ?? 'external',
        selectedCheckout: false,
        visible: linkedVisible
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
    mocks.state.showSleepingWorkspaces = true
    mocks.state.alwaysShowDefaultBranchWorkspace = true
    mocks.state.repos = []
    mocks.state.worktreesByRepo = {}
    mocks.state.detectedWorktreesByRepo = {}
    mocks.state.updateRepo.mockResolvedValue(true)
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
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      closeModal
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.onboardingUpdate).toHaveBeenCalledWith({
      checklist: { addedRepo: true }
    })
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

  it('reveals the project instead of opening a default checkout hidden by Hide default branch', async () => {
    const closeModal = vi.fn()
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      closeModal
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'clone_url',
      result: 'revealed_project',
      reason: 'default_checkout_hidden'
    })
    // Why: outside project grouping there is no header row, so the reveal request is
    // what switches grouping and scrolls to the new project.
    expect(mocks.state.revealSidebarRow).toHaveBeenCalledWith(
      'repo:repo-1',
      expect.objectContaining({ highlight: true })
    )
    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })

  it('opens a hidden default checkout anyway when the user picked a folder inside it', async () => {
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo/packages/web'
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      initialCwd: '/repo/packages/web'
    })
    expect(mocks.state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.state.revealSidebarRow).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
  })

  it('leaves both the filter and the sleeping exemption alone when Hide sleeping is also on', async () => {
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.showSleepingWorkspaces = false
    mocks.state.alwaysShowDefaultBranchWorkspace = false
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await openProjectDefaultCheckout({ repoId: 'repo-1', source: 'clone_url' })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'clone_url',
      result: 'revealed_project',
      reason: 'default_checkout_hidden'
    })
  })

  it('reveals only once when colliding repo IDs share a hidden default checkout', async () => {
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [
        makeWorktree({ id: 'repo-1::same-id', path: '/local/repo', hostId: 'local' }),
        makeWorktree({ id: 'repo-1::same-id', path: '/runtime/repo', hostId: 'runtime:env-1' })
      ]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'runtime_server_path',
      executionHostId: 'runtime:env-1'
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(
      mocks.track.mock.calls.filter(([event]) => event === 'add_repo_default_checkout_handoff')
    ).toHaveLength(1)
  })

  it('still opens a provisioned-root default checkout while Hide default branch is on', async () => {
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ ephemeralVmCheckoutMode: 'provisioned-root' })]
    }

    await openProjectDefaultCheckout({ repoId: 'repo-1', source: 'clone_url' })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
    expect(mocks.state.revealSidebarRow).not.toHaveBeenCalled()
  })

  it('still opens a detached-HEAD default checkout while Hide default branch is on', async () => {
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ branch: '' })]
    }

    await openProjectDefaultCheckout({ repoId: 'repo-1', source: 'clone_url' })

    // Why: the filter only hides rows that pass isDefaultBranchWorkspace, so a
    // branchless main row is visible and the handoff can land on it.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
    expect(mocks.state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
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
      executionHostId: 'runtime:env-1'
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
      executionHostId: 'runtime:env-1'
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
      selectedPath: '/repo/packages/web'
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
      selectedPath: '/repo'
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('shows a hidden detected default checkout before activating it', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          {
            ...defaultCheckout,
            ownership: 'external',
            selectedCheckout: false,
            visible: false
          }
        ]
      }
    }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = {
        'repo-1': [defaultCheckout]
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show'
    })
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

  it('reveals detected sibling external worktrees when the default checkout is already loaded', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show'
    })
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true
    })
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('does not refresh already-visible sibling external worktrees', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout, { linkedVisible: true })
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('does not flip visibility when the only hidden siblings are agent scratch', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout, { linkedOwnership: 'agent-scratch' })
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('does not repeat linked-worktree reveal after a hidden default checkout refresh', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        ...makeDetectedLinkedWorktrees(defaultCheckout),
        worktrees: [
          {
            ...defaultCheckout,
            ownership: 'external',
            selectedCheckout: true,
            visible: false
          },
          ...makeDetectedLinkedWorktrees(defaultCheckout).worktrees.slice(1)
        ]
      }
    }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = {
        'repo-1': [defaultCheckout]
      }
      mocks.state.detectedWorktreesByRepo = {
        'repo-1': makeDetectedLinkedWorktrees(defaultCheckout, { linkedVisible: true })
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledTimes(1)
    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show'
    })
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'detected_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('reveals the project if showing sibling external worktrees fails', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }
    mocks.state.updateRepo.mockResolvedValue(false)

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'revealed_project',
      reason: 'show_detected_linked_failed'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
  })

  it('reveals the project if sibling external worktree refresh is not authoritative', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }
    mocks.state.fetchWorktrees.mockResolvedValue(false)

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker'
    })

    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'revealed_project',
      reason: 'linked_external_refresh_failed'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
  })

  it('reveals the project if no default checkout is available', async () => {
    const closeModal = vi.fn()
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ isMainWorktree: false })]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'ssh_remote_path',
      closeModal
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'ssh_remote_path',
      result: 'revealed_project',
      reason: 'no_authoritative_detection'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
  })

  it('reveals the project even when no worktrees are loaded', async () => {
    mocks.state.activeRepoId = 'repo-2'
    mocks.state.filterRepoIds = ['repo-2']
    mocks.state.showActiveOnly = true

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat'
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'project_added_compat',
      result: 'revealed_project',
      reason: 'no_authoritative_detection'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(mocks.state.setFilterRepoIds).toHaveBeenCalledWith([])
    expect(mocks.state.setShowActiveOnly).toHaveBeenCalledWith(false)
  })
})
