/* eslint-disable max-lines -- Why: WorktreeList render tests share expensive mocks so focused sidebar regressions can exercise the real component boundary. */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup, Repo, Worktree, WorktreeLineage } from '../../../../shared/types'

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}))

type WorktreeListComponent = React.ComponentType<{
  scrollOffsetRef: React.RefObject<number>
  scrollAnchorRef: React.RefObject<unknown>
}>

let WorktreeList: WorktreeListComponent

vi.mock('@/store', () => {
  const useAppStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStore.state)) as ((
    selector: (state: Record<string, unknown>) => unknown
  ) => unknown) & {
    getState: () => Record<string, unknown>
  }
  useAppStore.getState = () => mockStore.state
  return { useAppStore }
})

vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) =>
    Array.from({ length: endIndex - startIndex + 1 }, (_, index) => startIndex + index),
  measureElement: () => 32,
  useVirtualizer: ({ count }: { count: number }) => ({
    elementsCache: new Map(),
    getTotalSize: () => count * 80,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: `row-${index}`,
        start: index * 80
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn()
  })
}))

vi.mock('@/hooks/useVirtualizedScrollAnchor', () => ({
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT: 'orca:test-record-scroll-anchor',
  useVirtualizedScrollAnchor: vi.fn()
}))

vi.mock('./project-header-drag', () => ({
  useRepoHeaderDrag: () => ({
    state: { draggingRepoId: null, dropIndicatorY: null },
    onHandlePointerDown: vi.fn()
  })
}))

vi.mock('./WorktreeCard', () => ({
  default: ({
    worktree,
    repo,
    isActive,
    contentIndent,
    flushSurface,
    lineageChildCount,
    lineageCollapsed,
    lineageChildren
  }: {
    worktree: Worktree
    repo?: Repo
    isActive?: boolean
    contentIndent?: number
    flushSurface?: boolean
    lineageChildCount?: number
    lineageCollapsed?: boolean
    lineageChildren?: React.ReactNode
  }) => {
    const deleteStateByWorktreeId =
      (mockStore.state.deleteStateByWorktreeId as Record<
        string,
        { isDeleting?: boolean } | undefined
      >) ?? {}
    const cardProps = (mockStore.state.worktreeCardProperties as string[] | undefined) ?? []
    const sshState =
      repo?.connectionId && mockStore.state.sshConnectionStates instanceof Map
        ? mockStore.state.sshConnectionStates.get(repo.connectionId)
        : null
    const isDeleting = deleteStateByWorktreeId[worktree.id]?.isDeleting === true
    const showSshDialog = isActive && repo?.connectionId && sshState?.status !== 'connected'

    return React.createElement(
      'section',
      {
        'data-worktree-card-id': worktree.id,
        'data-worktree-card-active': isActive ? 'true' : undefined,
        'data-content-indent': contentIndent,
        'data-flush-surface': flushSurface ? 'true' : undefined,
        'data-lineage-child-count': lineageChildCount,
        'data-lineage-collapsed':
          lineageCollapsed === undefined ? undefined : String(lineageCollapsed),
        'data-linked-pr': worktree.linkedPR ?? undefined,
        'data-linked-gitlab-mr': worktree.linkedGitLabMR ?? undefined,
        'aria-busy': isDeleting ? 'true' : undefined
      },
      React.createElement('h2', null, worktree.displayName),
      isDeleting ? React.createElement('span', null, 'Deleting') : null,
      cardProps.includes('unread') && worktree.isUnread
        ? React.createElement('button', { 'aria-label': 'Mark as read' }, 'Unread')
        : null,
      lineageChildCount
        ? React.createElement(
            'button',
            {
              'data-lineage-toggle-for': worktree.id,
              'aria-expanded': lineageCollapsed ? 'false' : 'true'
            },
            `${lineageChildCount} ${lineageChildCount === 1 ? 'child' : 'children'}`
          )
        : null,
      showSshDialog
        ? React.createElement('aside', {
            'data-worktree-card-ssh-dialog': 'open',
            'data-ssh-status': sshState?.status ?? 'disconnected',
            'data-ssh-target-id': repo?.connectionId
          })
        : null,
      lineageChildren
    )
  }
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: ({ worktreeId }: { worktreeId: string }) =>
    React.createElement(
      'div',
      { role: 'group', 'aria-label': 'Agents', 'data-agent-worktree-id': worktreeId },
      'Review fixture prompt'
    )
}))

vi.mock('./WorktreeTitleInlineRename', () => ({
  WorktreeTitleInlineRename: ({ displayName }: { displayName: string }) =>
    React.createElement('span', { 'data-worktree-title-inline-rename': '' }, displayName)
}))

vi.mock('./WorktreeActivityStatusIndicator', () => ({
  WorktreeActivityStatusIndicator: () => React.createElement('span', { 'data-status-dot': true })
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

vi.mock('./SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: ({
    open,
    status,
    targetId,
    targetLabel
  }: {
    open: boolean
    status: string
    targetId: string
    targetLabel: string
  }) =>
    React.createElement('aside', {
      'data-lineage-ssh-dialog': open ? 'open' : 'closed',
      'data-ssh-status': status,
      'data-ssh-target-id': targetId,
      'data-ssh-target-label': targetLabel
    })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children)
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children)
}))

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/lineage-order',
    displayName: 'lineage-order',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(args: {
  id: string
  displayName: string
  branch: string
  sortOrder: number
  instanceId: string
}): Worktree {
  return {
    id: args.id,
    instanceId: args.instanceId,
    repoId: 'repo-1',
    path: `/tmp/lineage-order/${args.id}`,
    displayName: args.displayName,
    branch: args.branch,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: args.sortOrder,
    lastActivityAt: args.sortOrder
  }
}

function makeLineage(worktree: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: worktree.id,
    worktreeInstanceId: worktree.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
}

function setLineageFixtureState(
  groupBy: 'none' | 'repo' = 'none',
  options: {
    childWorktreeOverrides?: Partial<Worktree>
    deletingWorktreeIds?: string[]
    projectGrouped?: boolean
    unreadWorktreeIds?: string[]
  } = {}
): void {
  const projectGroup: ProjectGroup = {
    id: 'project-group-1',
    name: 'Personal',
    parentPath: '/tmp/lineage-order',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const repo = {
    ...makeRepo(),
    projectGroupId: options.projectGrouped ? projectGroup.id : null
  }
  const parent = makeWorktree({
    id: 'parent',
    instanceId: 'parent-instance',
    displayName: 'lineage parent',
    branch: 'parent-branch',
    sortOrder: 30
  })
  const child = makeWorktree({
    id: 'child',
    instanceId: 'child-instance',
    displayName: 'lineage child with agent',
    branch: 'child-branch',
    sortOrder: 20
  })
  Object.assign(child, options.childWorktreeOverrides)
  const grandchild = makeWorktree({
    id: 'grandchild',
    instanceId: 'grandchild-instance',
    displayName: 'lineage grandchild',
    branch: 'grandchild-branch',
    sortOrder: 10
  })
  const unreadWorktreeIds = new Set(options.unreadWorktreeIds ?? [])
  parent.isUnread = unreadWorktreeIds.has(parent.id)
  child.isUnread = unreadWorktreeIds.has(child.id)
  grandchild.isUnread = unreadWorktreeIds.has(grandchild.id)

  mockStore.state = {
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: null,
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    collapsedGroups: new Set<string>(),
    deleteStateByWorktreeId: Object.fromEntries(
      (options.deletingWorktreeIds ?? []).map((worktreeId) => [
        worktreeId,
        { isDeleting: true, error: null, canForceDelete: false }
      ])
    ),
    filterRepoIds: [],
    groupBy,
    hideDefaultBranchWorkspace: false,
    issueCache: {},
    migrationUnsupportedByPtyId: {},
    openModal: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    prVisibleRefreshGeneration: 0,
    projectGroups: options.projectGrouped ? [projectGroup] : [],
    ptyIdsByTabId: {},
    reorderRepos: vi.fn(),
    reportVisibleGitHubPRRefreshCandidates: vi.fn(),
    retainedAgentsByPaneKey: {},
    repos: [repo],
    runtimePaneTitlesByTabId: {},
    setFilterRepoIds: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setRenamingWorktreeId: vi.fn(),
    setShowSleepingWorkspaces: vi.fn(),
    setSortBy: vi.fn(),
    settings: null,
    renamingWorktreeId: null,
    showSleepingWorkspaces: true,
    sortBy: 'manual',
    sortEpoch: 0,
    sshConnectedGeneration: 0,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    toggleCollapsedGroup: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    workspaceStatuses: [],
    worktreeCardProperties: ['status', 'inline-agents'],
    worktreeLineageById: {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    },
    worktreesByRepo: {
      [repo.id]: [parent, child, grandchild]
    }
  }
}

function setProjectGroupWithoutWorktreeRowsState(filterRepoIds: string[] = []): void {
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'Imported Services',
    parentPath: '/tmp/imported-services',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const repo: Repo = {
    ...makeRepo(),
    projectGroupId: group.id
  }

  mockStore.state = {
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: null,
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    collapsedGroups: new Set<string>(),
    deleteStateByWorktreeId: {},
    filterRepoIds,
    groupBy: 'repo',
    hideDefaultBranchWorkspace: false,
    issueCache: {},
    migrationUnsupportedByPtyId: {},
    openModal: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    prVisibleRefreshGeneration: 0,
    projectGroups: [group],
    ptyIdsByTabId: {},
    reorderRepos: vi.fn(),
    reportVisibleGitHubPRRefreshCandidates: vi.fn(),
    retainedAgentsByPaneKey: {},
    repos: [repo],
    runtimePaneTitlesByTabId: {},
    setFilterRepoIds: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setRenamingWorktreeId: vi.fn(),
    setShowSleepingWorkspaces: vi.fn(),
    setSortBy: vi.fn(),
    settings: null,
    renamingWorktreeId: null,
    showSleepingWorkspaces: true,
    sortBy: 'recent',
    sortEpoch: 0,
    sshConnectedGeneration: 0,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    toggleCollapsedGroup: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    workspaceStatuses: [],
    worktreeCardProperties: ['status', 'inline-agents'],
    worktreeLineageById: {},
    worktreesByRepo: {
      [repo.id]: []
    }
  }
}

function setEmptyUngroupedProjectState(filterRepoIds: string[] = []): void {
  const repo: Repo = {
    ...makeRepo(),
    displayName: 'empty-project'
  }

  mockStore.state = {
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: null,
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    collapsedGroups: new Set<string>(),
    deleteStateByWorktreeId: {},
    filterRepoIds,
    groupBy: 'repo',
    hideDefaultBranchWorkspace: false,
    issueCache: {},
    migrationUnsupportedByPtyId: {},
    openModal: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    prVisibleRefreshGeneration: 0,
    projectGroups: [],
    ptyIdsByTabId: {},
    reorderRepos: vi.fn(),
    reportVisibleGitHubPRRefreshCandidates: vi.fn(),
    retainedAgentsByPaneKey: {},
    repos: [repo],
    runtimePaneTitlesByTabId: {},
    setFilterRepoIds: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setRenamingWorktreeId: vi.fn(),
    setShowSleepingWorkspaces: vi.fn(),
    setSortBy: vi.fn(),
    settings: null,
    renamingWorktreeId: null,
    showSleepingWorkspaces: true,
    sortBy: 'recent',
    sortEpoch: 0,
    sshConnectedGeneration: 0,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    toggleCollapsedGroup: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    workspaceStatuses: [],
    worktreeCardProperties: ['status', 'inline-agents'],
    worktreeLineageById: {},
    worktreesByRepo: {
      [repo.id]: []
    }
  }
}

async function renderWorktreeListMarkup(): Promise<string> {
  return renderToStaticMarkup(
    React.createElement(WorktreeList, {
      scrollOffsetRef: { current: 0 },
      scrollAnchorRef: { current: null }
    })
  )
}

function getCardOpeningTag(markup: string, worktreeId: string): string {
  return (
    markup.match(new RegExp(`<section[^>]*data-worktree-card-id="${worktreeId}"[^>]*>`))?.[0] ?? ''
  )
}

function getOptionOpeningTag(markup: string, worktreeId: string): string {
  return (
    markup.match(new RegExp(`<div[^>]*id="worktree-list-option-${worktreeId}"[^>]*>`))?.[0] ?? ''
  )
}

describe('WorktreeList lineage child card renderer', () => {
  beforeAll(async () => {
    WorktreeList = (await import('./WorktreeList')).default as WorktreeListComponent
  }, 20_000)

  it('renders project group headers when repos import before worktree rows load', async () => {
    setProjectGroupWithoutWorktreeRowsState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('Imported Services')
    expect(markup).not.toContain('No workspaces found')
  })

  it('shows Clear Filters when filters exclude pre-worktree project groups', async () => {
    setProjectGroupWithoutWorktreeRowsState(['another-repo'])
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('No workspaces found')
    expect(markup).toContain('Clear Filters')
    expect(markup).not.toContain('Imported Services')
  })

  it('renders an empty ungrouped project instead of the empty workspace state', async () => {
    setEmptyUngroupedProjectState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('empty-project')
    expect(markup).not.toContain('No workspaces found')
  })

  it('shows Clear Filters when repo filters exclude an empty ungrouped project', async () => {
    setEmptyUngroupedProjectState(['another-repo'])
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('No workspaces found')
    expect(markup).toContain('Clear Filters')
    expect(markup).not.toContain('empty-project')
  })

  it('renders recursive lineage descendants through WorktreeCard once', async () => {
    setLineageFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(markup.match(/data-worktree-card-id="parent"/g)).toHaveLength(1)
    expect(markup.match(/data-worktree-card-id="child"/g)).toHaveLength(1)
    expect(markup.match(/data-worktree-card-id="grandchild"/g)).toHaveLength(1)

    const parentIndex = markup.indexOf('data-worktree-card-id="parent"')
    const childIndex = markup.indexOf('data-worktree-card-id="child"')
    const grandchildIndex = markup.indexOf('data-worktree-card-id="grandchild"')

    expect(parentIndex).toBeGreaterThan(-1)
    expect(childIndex).toBeGreaterThan(parentIndex)
    expect(grandchildIndex).toBeGreaterThan(childIndex)
    expect(getCardOpeningTag(markup, 'child')).toContain('data-lineage-child-count="1"')
  })

  it('passes child review details through the shared WorktreeCard path', async () => {
    setLineageFixtureState('none', {
      childWorktreeOverrides: { linkedPR: 456, linkedGitLabMR: 42 }
    })
    const markup = await renderWorktreeListMarkup()
    const childCard = getCardOpeningTag(markup, 'child')

    expect(childCard).toContain('data-linked-pr="456"')
    expect(childCard).toContain('data-linked-gitlab-mr="42"')
  })

  it('uses shared nested-row indentation for child and grandchild cards', async () => {
    setLineageFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(getOptionOpeningTag(markup, 'child')).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-content-indent="0"')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-flush-surface="true"')
    expect(getOptionOpeningTag(markup, 'grandchild')).toContain('padding-left:28px')
    expect(getCardOpeningTag(markup, 'grandchild')).toContain('data-content-indent="0"')
    expect(getCardOpeningTag(markup, 'grandchild')).toContain('data-flush-surface="true"')
  })

  it('shows deleting feedback on nested lineage child cards', async () => {
    setLineageFixtureState('none', { deletingWorktreeIds: ['child'] })
    const markup = await renderWorktreeListMarkup()
    const childCard = getCardOpeningTag(markup, 'child')
    const childIndex = markup.indexOf('data-worktree-card-id="child"')
    const childMarkup = markup.slice(
      childIndex,
      markup.indexOf('data-worktree-card-id="grandchild"')
    )

    expect(childCard).toContain('aria-busy="true"')
    expect(childMarkup).toContain('Deleting')
  })

  it('shows the unread bell action on unread nested lineage child cards', async () => {
    setLineageFixtureState('none', { unreadWorktreeIds: ['child'] })
    mockStore.state.worktreeCardProperties = ['status', 'unread', 'inline-agents']
    const markup = await renderWorktreeListMarkup()
    const childIndex = markup.indexOf('data-worktree-card-id="child"')
    const childMarkup = markup.slice(
      childIndex,
      markup.indexOf('data-worktree-card-id="grandchild"')
    )

    expect(childMarkup).toContain('aria-label="Mark as read"')
    expect(childMarkup).not.toContain('aria-label="Mark as unread"')
  })

  it('lets WorktreeCard own the reconnect dialog for an active disconnected lineage child', async () => {
    setLineageFixtureState()
    const repo = (mockStore.state.repos as Repo[])[0]!
    repo.connectionId = 'ssh-target-1'
    mockStore.state.activeWorktreeId = 'child'
    mockStore.state.sshConnectionStates = new Map([['ssh-target-1', { status: 'disconnected' }]])
    mockStore.state.sshTargetLabels = new Map([['ssh-target-1', 'Remote target']])

    const markup = await renderWorktreeListMarkup()

    expect(getCardOpeningTag(markup, 'child')).toContain('data-worktree-card-active="true"')
    expect(markup).toContain('data-worktree-card-ssh-dialog="open"')
    expect(markup).not.toContain('data-lineage-ssh-dialog="open"')
    expect(markup).toContain('data-ssh-status="disconnected"')
    expect(markup).toContain('data-ssh-target-id="ssh-target-1"')
  })

  it('does not add group indentation when grouping is disabled', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')

    expect(parentRow).toContain('id="worktree-list-option-parent"')
    expect(parentRow).not.toContain('padding-left')
  })

  it('passes one group indentation step into the card when grouped by project', async () => {
    setLineageFixtureState('repo')
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')

    expect(parentRow).not.toContain('padding-left')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-content-indent="20"')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-flush-surface="true"')
  })

  it('keeps nested card inner padding aligned with grouped parent cards', async () => {
    setLineageFixtureState('repo')
    const markup = await renderWorktreeListMarkup()

    expect(getOptionOpeningTag(markup, 'child')).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-content-indent="20"')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-flush-surface="true"')
  })

  it('keeps nested card inner padding aligned inside project groups', async () => {
    setLineageFixtureState('repo', { projectGrouped: true })
    const markup = await renderWorktreeListMarkup()

    expect(getOptionOpeningTag(markup, 'child')).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-content-indent="38"')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-flush-surface="true"')
  })

  it('adds project group depth to workspace card content indentation', async () => {
    setLineageFixtureState('repo', { projectGrouped: true })
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')

    expect(parentRow).not.toContain('padding-left')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-content-indent="38"')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-flush-surface="true"')
  })
})
