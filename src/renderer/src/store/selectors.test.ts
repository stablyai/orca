import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo, TerminalTab, Worktree } from '../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from './types'
import {
  getAllWorktreesFromState,
  getProjectHostSetupProjectionFromState,
  getWorktreeMapFromState,
  resetFloatingVisibleTabCountSelectorCacheForTest,
  selectFloatingVisibleTabCount
} from './selectors'
import { selectActiveTerminalChromeState } from './active-terminal-chrome-selector'

function makeWorktree(args: { id: string; repoId: string; displayName: string }): Worktree {
  return {
    id: args.id,
    repoId: args.repoId,
    displayName: args.displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: args.id,
    head: 'HEAD',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}

function makeRepo(args: Pick<Repo, 'id' | 'path' | 'displayName'> & Partial<Repo>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...args
  }
}

function makeTerminalTab(args: { id: string; worktreeId: string; title: string }): TerminalTab {
  return {
    id: args.id,
    ptyId: null,
    worktreeId: args.worktreeId,
    title: args.title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('store selectors', () => {
  beforeEach(() => {
    resetFloatingVisibleTabCountSelectorCacheForTest()
  })

  it('deduplicates cached worktree snapshots without changing reference reuse', () => {
    const first = makeWorktree({ id: 'wt-1', repoId: 'repo-1', displayName: 'first' })
    const second = makeWorktree({ id: 'wt-2', repoId: 'repo-1', displayName: 'second' })
    const replacement = makeWorktree({
      id: 'wt-1',
      repoId: 'repo-2',
      displayName: 'replacement'
    })
    const state = {
      worktreesByRepo: {
        'repo-1': [first, second],
        'repo-2': [replacement]
      }
    }

    const allWorktrees = getAllWorktreesFromState(state)
    const worktreeMap = getWorktreeMapFromState(state)

    expect(allWorktrees).toEqual([replacement, second])
    expect(worktreeMap.get('wt-1')).toBe(replacement)
    expect(getAllWorktreesFromState(state)).toBe(allWorktrees)
    expect(getWorktreeMapFromState(state)).toBe(worktreeMap)
  })

  it('reuses the floating tab-count projection across unrelated store ticks', () => {
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    const terminalTabs = [
      {
        id: 'term-1',
        ptyId: null,
        worktreeId,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ] as AppState['tabsByWorktree'][string]
    const browserTabs = [{ id: 'browser-1' }] as AppState['browserTabsByWorktree'][string]
    let openFileScans = 0
    const fileEntries = [
      {
        id: 'file-1',
        filePath: '/tmp/file-1.ts',
        relativePath: 'file-1.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      },
      {
        id: 'file-2',
        filePath: '/tmp/file-2.ts',
        relativePath: 'file-2.ts',
        worktreeId: 'repo::/elsewhere',
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      }
    ] as AppState['openFiles']
    const openFiles = [...fileEntries] as AppState['openFiles']
    Object.defineProperty(openFiles, Symbol.iterator, {
      value: function* () {
        openFileScans += 1
        for (const entry of fileEntries) {
          yield entry
        }
      }
    })
    const unifiedTabs = [
      {
        id: 'unified-term-1',
        entityId: 'term-1',
        worktreeId,
        contentType: 'terminal',
        label: 'Terminal',
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: 'unified-browser-1',
        entityId: 'browser-1',
        worktreeId,
        contentType: 'browser',
        label: 'Browser',
        sortOrder: 1,
        createdAt: 2
      },
      {
        id: 'unified-file-1',
        entityId: 'file-1',
        worktreeId,
        contentType: 'editor',
        label: 'file-1.ts',
        sortOrder: 2,
        createdAt: 3
      },
      {
        id: 'unified-stale-terminal',
        entityId: 'missing-term',
        worktreeId,
        contentType: 'terminal',
        label: 'Stale',
        sortOrder: 3,
        createdAt: 4
      }
    ] as AppState['unifiedTabsByWorktree'][string]
    const state = {
      tabsByWorktree: { [worktreeId]: terminalTabs },
      browserTabsByWorktree: { [worktreeId]: browserTabs },
      openFiles,
      unifiedTabsByWorktree: { [worktreeId]: unifiedTabs }
    } satisfies Parameters<typeof selectFloatingVisibleTabCount>[0]

    expect(selectFloatingVisibleTabCount(state)).toBe(3)
    expect(openFileScans).toBe(1)

    expect(selectFloatingVisibleTabCount({ ...state })).toBe(3)
    expect(openFileScans).toBe(1)
  })

  it('keeps active terminal chrome stable across title-only tab updates', () => {
    const activeTab = makeTerminalTab({
      id: 'term-1',
      worktreeId: 'wt-1',
      title: 'Codex working'
    })
    const secondTab = makeTerminalTab({
      id: 'term-2',
      worktreeId: 'wt-1',
      title: 'Shell'
    })
    const otherWorktreeTab = makeTerminalTab({
      id: 'term-other',
      worktreeId: 'wt-2',
      title: 'Background'
    })
    const state = {
      activeWorktreeId: 'wt-1',
      activeTabId: 'term-1',
      tabsByWorktree: {
        'wt-1': [activeTab, secondTab],
        'wt-2': [otherWorktreeTab]
      },
      canExpandPaneByTabId: { 'term-1': true, 'term-2': false },
      expandedPaneByTabId: { 'term-1': true, 'term-2': false }
    } satisfies Parameters<typeof selectActiveTerminalChromeState>[0]

    const selected = selectActiveTerminalChromeState(state)
    const retitledState = {
      ...state,
      tabsByWorktree: {
        'wt-1': [{ ...activeTab, title: 'Codex working · frame 2' }, secondTab],
        'wt-2': [{ ...otherWorktreeTab, title: 'Background · frame 2' }]
      }
    } satisfies Parameters<typeof selectActiveTerminalChromeState>[0]

    expect(selected).toEqual({
      activeWorktreeId: 'wt-1',
      activeTabId: 'term-1',
      tabCount: 2,
      effectiveActiveTabId: 'term-1',
      activeTabCanExpand: true,
      effectiveActiveTabExpanded: true
    })
    expect(selectActiveTerminalChromeState(retitledState)).toEqual(selected)
  })

  it('caches the project host setup projection by repo slice identity', () => {
    const repos = [
      makeRepo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca'
      })
    ]
    const state = { repos }

    const projection = getProjectHostSetupProjectionFromState(state)

    expect(projection.projects).toHaveLength(1)
    expect(projection.setups[0]).toMatchObject({
      id: 'repo-1',
      projectId: 'repo:repo-1',
      hostId: 'local'
    })
    expect(getProjectHostSetupProjectionFromState({ repos })).toBe(projection)
    expect(getProjectHostSetupProjectionFromState({ repos: [...repos] })).not.toBe(projection)
  })

  it('prefers hydrated project host setup state when present', () => {
    const repos = [
      makeRepo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca'
      })
    ]
    const projects = [
      {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#737373',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const projectHostSetups = [
      {
        id: 'setup-1',
        projectId: 'project-1',
        hostId: 'local' as const,
        repoId: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        setupState: 'ready' as const,
        setupMethod: 'legacy-repo' as const,
        createdAt: 1,
        updatedAt: 1
      }
    ]

    expect(getProjectHostSetupProjectionFromState({ repos, projects, projectHostSetups })).toEqual({
      projects,
      setups: projectHostSetups
    })
  })

  it('falls back to repo compatibility projection when hydrated setup state is empty', () => {
    const repos = [
      makeRepo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        upstream: { owner: 'stablyai', repo: 'orca' }
      })
    ]

    const projection = getProjectHostSetupProjectionFromState({
      repos,
      projects: [],
      projectHostSetups: []
    })

    expect(projection.projects).toEqual([
      expect.objectContaining({
        id: 'github:stablyai/orca',
        sourceRepoIds: ['repo-1']
      })
    ])
    expect(projection.setups).toEqual([
      expect.objectContaining({
        id: 'repo-1',
        projectId: 'github:stablyai/orca',
        repoId: 'repo-1',
        hostId: 'local',
        path: '/Users/alice/orca'
      })
    ])
  })

  it('merges missing repo compatibility rows with independent hydrated setups', () => {
    const repos = [
      makeRepo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca'
      })
    ]
    const projects = [
      {
        id: 'cloud-project',
        displayName: 'Cloud Project',
        badgeColor: '#737373',
        sourceRepoIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const projectHostSetups = [
      {
        id: 'cloud-project::gpu-vm',
        projectId: 'cloud-project',
        hostId: toRuntimeExecutionHostId('gpu-vm'),
        repoId: '',
        path: '/srv/cloud-project',
        displayName: 'GPU VM',
        setupState: 'ready' as const,
        setupMethod: 'provisioned' as const,
        createdAt: 1,
        updatedAt: 1
      }
    ]

    const projection = getProjectHostSetupProjectionFromState({
      repos,
      projects,
      projectHostSetups
    })

    expect(projection.projects.map((project) => project.id)).toEqual([
      'repo:repo-1',
      'cloud-project'
    ])
    expect(projection.setups.map((setup) => setup.id)).toEqual(['repo-1', 'cloud-project::gpu-vm'])
    expect(getProjectHostSetupProjectionFromState({ repos, projects, projectHostSetups })).toBe(
      projection
    )
  })
})
