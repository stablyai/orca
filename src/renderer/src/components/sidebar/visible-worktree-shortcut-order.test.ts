import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  TerminalTab,
  Worktree
} from '../../../../shared/types'
import type { AppState } from '@/store/types'
import type { AgentSendPopoverTargetMode } from '@/store/slices/ui'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type AppStore = Pick<StoreApi<AppState>, 'getState' | 'setState'>

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 0
}

const remoteRepo: Repo = {
  ...repo,
  id: 'remote-repo',
  path: '/remote/repo',
  displayName: 'Remote Repo',
  connectionId: 'remote'
}

function makeWorktree(id: string, sortOrder: number, lastActivityAt: number): Worktree {
  return {
    id,
    repoId: repo.id,
    path: `/repo/${id}`,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder,
    lastActivityAt
  }
}

function makeFolderWorkspace(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group',
    name: id,
    folderPath: `/folders/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeProjectGroup(id = 'group'): ProjectGroup {
  return {
    id,
    name: 'Group',
    parentPath: '/folders',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeAgentSendMode(worktreeId: string): AgentSendPopoverTargetMode {
  return {
    id: 'mode-1',
    instanceId: 'instance-1',
    worktreeId,
    source: 'diff-notes',
    prompt: 'Review this',
    label: 'Send',
    launchSource: 'sidebar',
    eligiblePaneKeys: [],
    disabledPaneKeys: {},
    status: 'open'
  }
}

function makeEligibleAgentState(worktreeId: string): Partial<AppState> {
  const tabId = `${worktreeId}-tab`
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = makePaneKey(tabId, leafId)
  const tab: TerminalTab = {
    id: tabId,
    ptyId: `${worktreeId}-pty`,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    agentSendPopoverTargetMode: makeAgentSendMode(worktreeId),
    tabsByWorktree: { [worktreeId]: [tab] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: tab.ptyId! }
      }
    },
    ptyIdsByTabId: { [tabId]: [tab.ptyId!] },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        state: 'working',
        prompt: 'Working',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        stateHistory: []
      }
    }
  }
}

function makePendingCreation(creationId: string, repoId: string): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'fetching',
    status: 'creating',
    startedAt: 0,
    indeterminate: false,
    loaderVisible: false,
    request: {
      repoId,
      name: 'feature',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
  }
}

function setVisibleState(
  store: AppStore,
  worktrees: Worktree[],
  overrides: Partial<AppState> = {}
): void {
  store.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: worktrees },
    folderWorkspaces: [],
    projectGroups: [],
    sortBy: 'name',
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: {},
    migrationUnsupportedByPtyId: {},
    terminalLayoutsByTabId: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    worktreeLineageById: {},
    collapsedGroups: new Set(),
    ...overrides
  })
}

async function loadFreshOrderState(): Promise<{
  store: AppStore
  getVisibleWorktreeIds: () => string[]
  registerVisibleWorktreeIdsPublisher: () => () => void
  setVisibleWorktreeIds: (ids: string[]) => void
}> {
  vi.resetModules()
  const [{ useAppStore }, orderState] = await Promise.all([
    import('@/store'),
    import('./visible-worktrees')
  ])
  return { store: useAppStore, ...orderState }
}

describe('visible worktree shortcut order', () => {
  it('uses the published order directly while the sidebar publisher is mounted', async () => {
    const first = makeWorktree('first', 1, 0)
    const {
      store,
      getVisibleWorktreeIds,
      registerVisibleWorktreeIdsPublisher,
      setVisibleWorktreeIds
    } = await loadFreshOrderState()
    setVisibleState(store, [first], { groupBy: 'none' })
    setVisibleWorktreeIds([first.id])
    const unregisterPublisher = registerVisibleWorktreeIdsPublisher()

    setVisibleState(store, [first], {
      groupBy: 'none',
      collapsedGroups: new Set(['all'])
    })

    expect(getVisibleWorktreeIds()).toEqual([first.id])
    unregisterPublisher()
    expect(getVisibleWorktreeIds()).toEqual([])
  })

  it('keeps a rendered empty order instead of falling back to live state', async () => {
    const first = makeWorktree('first', 1, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first], { groupBy: 'none', collapsedGroups: new Set(['all']) })

    setVisibleWorktreeIds([])

    expect(getVisibleWorktreeIds()).toEqual([])
  })

  it('removes ineligible cached worktrees without reordering survivors', async () => {
    const first = makeWorktree('first', 1, 0)
    const second = makeWorktree('second', 2, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first, second])
    setVisibleWorktreeIds([second.id, first.id])

    setVisibleState(store, [{ ...first, isArchived: true }, second])

    expect(getVisibleWorktreeIds()).toEqual([second.id])
  })

  it('keeps folder workspaces in their published shortcut positions', async () => {
    const first = makeWorktree('first', 1, 0)
    const folder = makeFolderWorkspace('folder-one')
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first], {
      folderWorkspaces: [folder],
      projectGroups: [makeProjectGroup()]
    })

    setVisibleWorktreeIds([`folder:${folder.id}`, first.id])

    expect(getVisibleWorktreeIds()).toEqual([`folder:${folder.id}`, first.id])
  })

  it('appends worktrees discovered while the sidebar is closed', async () => {
    const first = makeWorktree('first', 1, 0)
    const second = makeWorktree('second', 2, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first])
    setVisibleWorktreeIds([first.id])

    setVisibleState(store, [first, second])

    expect(getVisibleWorktreeIds()).toEqual([first.id, second.id])
  })

  it('removes survivors and additions hidden under a collapsed group', async () => {
    const first = makeWorktree('first', 1, 0)
    const second = makeWorktree('second', 2, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first], { groupBy: 'none' })
    setVisibleWorktreeIds([first.id])

    setVisibleState(store, [first, second], { groupBy: 'none', collapsedGroups: new Set(['all']) })

    expect(getVisibleWorktreeIds()).toEqual([])
  })

  it('does not append worktrees hidden under a collapsed lineage parent', async () => {
    const first = { ...makeWorktree('first', 1, 0), instanceId: 'first-instance' }
    const second = { ...makeWorktree('second', 2, 0), instanceId: 'second-instance' }
    const lineage = {
      worktreeId: second.id,
      worktreeInstanceId: 'second-instance',
      parentWorktreeId: first.id,
      parentWorktreeInstanceId: 'first-instance',
      origin: 'cli' as const,
      capture: { source: 'cwd-context' as const, confidence: 'inferred' as const },
      createdAt: 0
    }
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first], { collapsedGroups: new Set([`lineage:${first.id}`]) })
    setVisibleWorktreeIds([first.id])

    setVisibleState(store, [first, second], {
      collapsedGroups: new Set([`lineage:${first.id}`]),
      worktreeLineageById: { [second.id]: lineage }
    })

    expect(getVisibleWorktreeIds()).toEqual([first.id])
  })

  it('does not append worktrees hidden under a collapsed host section', async () => {
    const remote = { ...makeWorktree('remote', 1, 0), repoId: remoteRepo.id }
    const local = makeWorktree('local', 2, 0)
    const hostOverrides: Partial<AppState> = {
      repos: [repo, remoteRepo],
      visibleWorkspaceHostIds: ['local', 'ssh:remote'],
      collapsedGroups: new Set(['host:local'])
    }
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [], {
      ...hostOverrides,
      worktreesByRepo: { [repo.id]: [], [remoteRepo.id]: [remote] }
    })
    setVisibleWorktreeIds([remote.id])

    setVisibleState(store, [], {
      ...hostOverrides,
      worktreesByRepo: { [repo.id]: [local], [remoteRepo.id]: [remote] }
    })

    expect(getVisibleWorktreeIds()).toEqual([remote.id])

    setVisibleState(store, [local], {
      ...hostOverrides,
      repos: [repo]
    })

    expect(getVisibleWorktreeIds()).toEqual([local.id])
  })

  it('reconsiders catalog worktrees hidden when the sidebar published', async () => {
    const remote = { ...makeWorktree('remote', 1, 0), repoId: remoteRepo.id }
    const local = makeWorktree('local', 2, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [], {
      repos: [repo, remoteRepo],
      worktreesByRepo: { [repo.id]: [local], [remoteRepo.id]: [remote] },
      visibleWorkspaceHostIds: ['local', 'ssh:remote'],
      collapsedGroups: new Set(['host:local'])
    })
    setVisibleWorktreeIds([remote.id])

    setVisibleState(store, [local], {
      repos: [repo],
      visibleWorkspaceHostIds: ['local', 'ssh:remote'],
      collapsedGroups: new Set(['host:local'])
    })

    expect(getVisibleWorktreeIds()).toEqual([local.id])
  })

  it('counts pending creation rows when applying collapsed host sections', async () => {
    const local = makeWorktree('local', 1, 0)
    const pending = makePendingCreation('pending-remote', remoteRepo.id)
    const overrides: Partial<AppState> = {
      repos: [repo, remoteRepo],
      visibleWorkspaceHostIds: ['local', 'ssh:remote'],
      collapsedGroups: new Set(['host:local']),
      pendingWorktreeCreations: { [pending.creationId]: pending }
    }
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [], overrides)
    setVisibleWorktreeIds([])

    setVisibleState(store, [local], overrides)

    expect(getVisibleWorktreeIds()).toEqual([])
  })

  it('adds only an eligible filtered agent target and expands its group', async () => {
    const first = makeWorktree('first', 1, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first], {
      filterRepoIds: ['another-repo'],
      groupBy: 'none',
      collapsedGroups: new Set(['all'])
    })
    setVisibleWorktreeIds([])

    setVisibleState(store, [first], {
      filterRepoIds: ['another-repo'],
      groupBy: 'none',
      collapsedGroups: new Set(['all']),
      ...makeEligibleAgentState(first.id)
    })

    expect(getVisibleWorktreeIds()).toEqual([first.id])

    setVisibleState(store, [first], {
      filterRepoIds: ['another-repo'],
      groupBy: 'none',
      collapsedGroups: new Set(['all']),
      agentSendPopoverTargetMode: makeAgentSendMode(first.id)
    })

    expect(getVisibleWorktreeIds()).toEqual([])
  })

  it('keeps the shortcut slot of an archived but still-rendered agent target', async () => {
    const first = makeWorktree('first', 1, 0)
    const second = makeWorktree('second', 2, 0)
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first, second])
    setVisibleWorktreeIds([first.id, second.id])

    const archivedSecond = { ...second, isArchived: true }
    setVisibleState(store, [first, archivedSecond], makeEligibleAgentState(second.id))

    expect(getVisibleWorktreeIds()).toEqual([first.id, second.id])

    setVisibleState(store, [first, archivedSecond])

    expect(getVisibleWorktreeIds()).toEqual([first.id])
  })

  it('keeps the rendered order while live smart-sort state changes', async () => {
    const first = makeWorktree('first', 2, 0)
    const second = makeWorktree('second', 1, 100)
    const secondTab: TerminalTab = {
      id: 'second-tab',
      ptyId: 'second-pty',
      worktreeId: second.id,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first, second], {
      sortBy: 'smart',
      tabsByWorktree: { [first.id]: [], [second.id]: [secondTab] },
      ptyIdsByTabId: { [secondTab.id]: [secondTab.ptyId!] }
    })

    setVisibleWorktreeIds([first.id, second.id])

    expect(getVisibleWorktreeIds()).toEqual([first.id, second.id])
  })

  it('removes cached survivors hidden by a filter while the sidebar is closed', async () => {
    const active = makeWorktree('active', 1, 0)
    const sleeping = makeWorktree('sleeping', 2, 0)
    const last = makeWorktree('last', 3, 0)
    const activeTab: TerminalTab = {
      id: 'active-tab',
      ptyId: 'active-pty',
      worktreeId: active.id,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const activityState: Partial<AppState> = {
      tabsByWorktree: {
        [active.id]: [activeTab],
        [sleeping.id]: [],
        [last.id]: [{ ...activeTab, id: 'last-tab', ptyId: 'last-pty', worktreeId: last.id }]
      },
      ptyIdsByTabId: { [activeTab.id]: [activeTab.ptyId!], 'last-tab': ['last-pty'] }
    }
    const { store, getVisibleWorktreeIds, setVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [active, sleeping, last], activityState)
    setVisibleWorktreeIds([active.id, sleeping.id, last.id])

    setVisibleState(store, [active, sleeping, last], {
      ...activityState,
      showSleepingWorkspaces: false
    })

    expect(getVisibleWorktreeIds()).toEqual([active.id, last.id])

    setVisibleState(store, [active, sleeping, last], activityState)

    expect(getVisibleWorktreeIds()).toEqual([active.id, sleeping.id, last.id])
  })

  it('uses live sorting before the sidebar publishes an order', async () => {
    const first = makeWorktree('first', 2, 0)
    const second = makeWorktree('second', 1, 100)
    const secondTab: TerminalTab = {
      id: 'second-tab',
      ptyId: 'second-pty',
      worktreeId: second.id,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const { store, getVisibleWorktreeIds } = await loadFreshOrderState()
    setVisibleState(store, [first, second], {
      sortBy: 'smart',
      tabsByWorktree: { [first.id]: [], [second.id]: [secondTab] },
      ptyIdsByTabId: { [secondTab.id]: [secondTab.ptyId!] }
    })

    expect(getVisibleWorktreeIds()).toEqual([second.id, first.id])
  })
})
