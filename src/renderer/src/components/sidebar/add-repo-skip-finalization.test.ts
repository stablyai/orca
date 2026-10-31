import { selectVisibleSidebarWorktrees } from '../../../../shared/sidebar-list/visible-worktrees'
import { getPinnedSectionWorktrees } from '../../../../shared/sidebar-list/pinned-section-worktrees'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import {
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFactReader
} from '../../../../shared/workspace-view/workspace-row-filters'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildProjectGroupingIndex } from '../../../../shared/project-section-grouping'
import { getEmptyProjectPlaceholderRepoIds } from '../../../../shared/sidebar-list/empty-project-placeholder-repos'
import { buildImportedWorktreesCardCandidates } from './imported-worktrees-card-candidates'
import { buildNewExternalWorktreesInboxCandidates } from './new-external-worktrees-inbox-candidates'
import { revealRepoInProjectFilter } from './project-filter-reveal'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getProjectGroupingIndexFromState } from '../../store/project-host-setup-selector'
import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  finalizeImportedRepoAfterSkip,
  type AddRepoSkipFinalizationState
} from './add-repo-skip-finalization'

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: `/tmp/${overrides.id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeState(overrides: Partial<AddRepoSkipFinalizationState>): AddRepoSkipFinalizationState {
  return {
    activeRepoId: null,
    filterRepoIds: [],
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
    repos: [],
    worktreesByRepo: {},
    setActiveRepo: vi.fn(),
    setFilterRepoIds: vi.fn(),
    setShowActiveOnly: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setAlwaysShowDefaultBranchWorkspace: vi.fn(),
    ...overrides
  }
}

describe('finalizeImportedRepoAfterSkip', () => {
  it('keeps skipped imported worktrees visible without activating a worktree', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [makeWorktree({ id: 'repo-new::/repo/feature', repoId: 'repo-new' })]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith(['repo-old', 'local\0repo-new'])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it.each(['repository', 'host', 'folder'] as const)(
    'reveals the imported logical group without losing offline scope in %s mode',
    (projectGroupingMode) => {
      const repos: Repo[] = [
        {
          id: 'first',
          path: '/app',
          displayName: 'App',
          badgeColor: '',
          addedAt: 0,
          upstream: { owner: 'org', repo: 'app' }
        },
        {
          id: 'second',
          path: '/app-copy',
          displayName: 'App',
          badgeColor: '',
          addedAt: 0,
          upstream: { owner: 'org', repo: 'app' }
        },
        {
          id: 'remote',
          path: '/remote/app',
          displayName: 'App',
          badgeColor: '',
          addedAt: 0,
          upstream: { owner: 'org', repo: 'app' },
          executionHostId: 'runtime:remote'
        }
      ]
      const grouping = getProjectGroupingIndexFromState({
        repos,
        settings: { ...getDefaultSettings('/home/test'), projectGroupingMode }
      })
      const state = makeState({ repos, filterRepoIds: ['offline', 'runtime:offline\0gone'] })
      finalizeImportedRepoAfterSkip(state, 'second', grouping)
      const selection = vi.mocked(state.setFilterRepoIds).mock.calls[0][0]
      expect(selection).toEqual(expect.arrayContaining(['offline', 'runtime:offline\0gone']))
      const matches = projectRepoFilterMatcher(selection)
      expect(
        repos
          .filter((repo) => matches(repo.id, repo.executionHostId ?? 'local'))
          .map((repo) => repo.id)
      ).toEqual(
        projectGroupingMode === 'repository'
          ? ['first', 'second', 'remote']
          : projectGroupingMode === 'host'
            ? ['first', 'second']
            : ['second']
      )
      expect(state.setActiveRepo).toHaveBeenCalledWith('second')
    }
  )

  it('leaves the project filter off when the import lands with no filter', () => {
    const state = makeState({ filterRepoIds: [] })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setFilterRepoIds).not.toHaveBeenCalled()
  })

  it('clears default-branch hiding when it would hide every imported worktree', () => {
    const state = makeState({
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
  })

  it('clears default-branch hiding for a folder project whose only row is its root', () => {
    const state = makeState({
      hideDefaultBranchWorkspace: true,
      repos: [{ id: 'folder-new', kind: 'folder' }],
      worktreesByRepo: {
        'folder-new': [
          makeWorktree({
            id: 'folder-new::/notes',
            repoId: 'folder-new',
            isMainWorktree: true,
            head: '',
            branch: ''
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'folder-new')

    expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
  })

  it.each([false, true])(
    'ignores archived siblings when revealing a folder root after Skip (root archived: %s)',
    (rootArchived) => {
      const state = makeState({
        hideDefaultBranchWorkspace: true,
        showSleepingWorkspaces: false,
        alwaysShowDefaultBranchWorkspace: false,
        repos: [{ id: 'folder-new', kind: 'folder' }],
        worktreesByRepo: {
          'folder-new': [
            makeWorktree({
              id: 'folder-new::/notes',
              repoId: 'folder-new',
              isMainWorktree: true,
              head: '',
              branch: '',
              isArchived: rootArchived
            }),
            makeWorktree({
              id: 'folder-new::/notes::workspace:archived',
              repoId: 'folder-new',
              head: '',
              branch: '',
              isArchived: true
            })
          ]
        }
      })

      finalizeImportedRepoAfterSkip(state, 'folder-new')

      if (rootArchived) {
        expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
        expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
      } else {
        expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
        expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
      }
    }
  )

  it('re-enables the default-branch exemption when the import would land asleep and hidden', () => {
    const state = makeState({
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
  })

  it('leaves the default-branch exemption alone when sleeping workspaces are shown', () => {
    const state = makeState({
      showSleepingWorkspaces: true,
      alwaysShowDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('still reveals the imported repo when it has no discovered worktrees yet', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: { 'repo-new': [] }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith(['repo-old', 'local\0repo-new'])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })
})

it('uses the physical nested source for explicit reveal and the reached Repo filter gates', () => {
  const target = { kind: 'environment', environmentId: 'E' } as const
  const authored = [
    { id: 'r', connectionId: 'x', executionHostId: 'ssh:x' as const, path: '/srv/r' },
    { id: 'r', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/r' },
    { id: 'q', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/q' }
  ].map((repo) => ({
    ...repo,
    displayName: repo.path,
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' },
    externalWorktreeVisibility: 'hide' as const
  }))
  const original = projectHostSetupProjectionFromRepos(authored)
  const projection = adoptEndpointProjectCatalog(target, original.projects, original.setups)
  const repos = authored.map((repo) => adoptEndpointRepo(target, repo))
  const index = buildProjectGroupingIndex({
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: { projectGroupingMode: 'host' }
  })
  const state = makeState({ repos, filterRepoIds: ['offline'] })
  revealRepoInProjectFilter(state, 'r', 'ssh:x', index)
  expect(state.setFilterRepoIds).toHaveBeenLastCalledWith(['offline', 'ssh:x\0r'])
  const hidden = {
    ...makeWorktree({ id: 'r::/srv/feature', repoId: 'r' }),
    hostId: 'ssh:x' as const,
    runtimeOwnerEnvironmentId: 'E',
    ownership: 'external' as const,
    visible: false,
    selectedCheckout: false
  }
  const detected = { repoId: 'r', authoritative: true, source: 'git' as const, worktrees: [hidden] }
  const selected = ['ssh:x\0r']
  const child = {
    ...makeWorktree({ id: 'r::child', repoId: 'r' }),
    hostId: 'ssh:x' as const,
    instanceId: 'child'
  }
  const parent = {
    ...makeWorktree({ id: 'q::parent', repoId: 'q' }),
    hostId: 'ssh:x' as const,
    instanceId: 'parent',
    isPinned: true
  }
  const lineage: Record<string, WorktreeLineage> = {
    [child.id]: {
      worktreeId: child.id,
      worktreeInstanceId: 'child',
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: 'parent',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
  }
  const byIdentity = new Map([parent, child].map((item) => [getWorktreeHostIdentity(item), item]))
  const facts: WorkspaceRowFactReader<Worktree> = {
    repoId: (item) => item.repoId,
    hostId: (item) => item.hostId ?? 'local',
    isArchived: (item) => item.isArchived,
    isFolderWorkspace: () => false,
    isOtherClient: () => false,
    isDefaultBranch: () => false,
    isAutomationCreated: () => false,
    isCliCreated: () => false,
    isDetachedHead: () => false,
    isMainWorktree: () => false,
    isSleeping: () => false
  }
  const visibleInputs = {
    rows: [parent, child],
    ancestorByIdentity: byIdentity,
    rankOf: (item: Worktree) => (item === parent ? 0 : 1),
    filters: { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: selected },
    facts,
    worktreeLineageById: lineage,
    filterRepoIds: selected
  }
  const visible = selectVisibleSidebarWorktrees(visibleInputs)
  expect(visible).toEqual([child])
  expect(getPinnedSectionWorktrees(visible, lineage, byIdentity, selected)).toEqual([])
  const broad = ['r', 'q']
  const all = selectVisibleSidebarWorktrees({
    ...visibleInputs,
    filters: { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: broad },
    filterRepoIds: broad
  })
  expect(all).toEqual([parent, child])
  expect(getPinnedSectionWorktrees(all, lineage, byIdentity, broad)).toEqual([parent, child])
  expect(
    selectVisibleSidebarWorktrees({ ...visibleInputs, forcedVisibleWorktreeIds: [parent.id] })
  ).toEqual([parent, child])
  expect(
    getEmptyProjectPlaceholderRepoIds({
      groupBy: 'repo',
      repos,
      worktreesByRepo: {},
      visibleWorktrees: [],
      filterRepoIds: selected
    }).size
  ).toBe(1)
  const imported = buildImportedWorktreesCardCandidates({
    repos,
    detectedWorktreesByRepo: { r: detected },
    filterRepoIds: selected
  })
  expect([...imported.values()].map((candidate) => candidate.repo)).toEqual([repos[0]])
  expect([...imported.values()][0].hiddenWorktrees).toEqual([hidden])
  const dismissed = repos.map((repo) => ({
    ...repo,
    externalWorktreeVisibilityPromptDismissedAt: 1,
    externalWorktreeInboxBaselinePaths: []
  }))
  const inbox = buildNewExternalWorktreesInboxCandidates({
    repos: dismissed,
    detectedWorktreesByRepo: { r: detected },
    filterRepoIds: selected
  })
  expect([...inbox.values()].map((candidate) => candidate.repo)).toEqual([dismissed[0]])
  expect([...inbox.values()][0].inboxWorktrees).toEqual([hidden])
  expect(
    buildImportedWorktreesCardCandidates({
      repos,
      detectedWorktreesByRepo: { r: detected },
      filterRepoIds: ['runtime:E\0r']
    }).size
  ).toBe(0)
  expect(
    buildNewExternalWorktreesInboxCandidates({
      repos: dismissed,
      detectedWorktreesByRepo: { r: detected },
      filterRepoIds: ['runtime:E\0r']
    }).size
  ).toBe(0)
})
