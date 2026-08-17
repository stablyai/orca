import type { Tab, TabGroup, TabGroupLayoutNode } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

export type WorkspaceSessionTerminalTabMoveResult = {
  session: WorkspaceSessionState
  moved: boolean
}

function pruneGroupLayout(
  node: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return validGroupIds.has(node.groupId) ? node : undefined
  }
  const first = pruneGroupLayout(node.first, validGroupIds)
  const second = pruneGroupLayout(node.second, validGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function findUnifiedTerminalTabs(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): Tab[] {
  return (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
  )
}

function pickNextActiveTab(group: TabGroup, closingIds: ReadonlySet<string>): string | null {
  const remaining = group.tabOrder.filter((id) => !closingIds.has(id))
  for (let index = (group.recentTabIds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const id = group.recentTabIds![index]
    if (remaining.includes(id)) {
      return id
    }
  }
  const closingIndex = group.tabOrder.findIndex((id) => closingIds.has(id))
  return (
    remaining.find((id) => group.tabOrder.indexOf(id) > closingIndex) ?? remaining.at(-1) ?? null
  )
}

function ensureDestGroup(
  session: WorkspaceSessionState,
  destWorktreeId: string
): { groups: TabGroup[]; group: TabGroup; layout: TabGroupLayoutNode } {
  const groups = [...(session.tabGroups?.[destWorktreeId] ?? [])]
  const existing = groups[0]
  if (existing) {
    return {
      groups,
      group: existing,
      layout: session.tabGroupLayouts?.[destWorktreeId] ?? { type: 'leaf', groupId: existing.id }
    }
  }
  const group: TabGroup = {
    id: `group-${destWorktreeId}`,
    worktreeId: destWorktreeId,
    activeTabId: null,
    tabOrder: [],
    recentTabIds: []
  }
  return {
    groups: [group],
    group,
    layout: { type: 'leaf', groupId: group.id }
  }
}

const WORKTREE_KEYED_SESSION_FIELDS = [
  'tabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree'
] as const

export function assertWorkspaceSessionTerminalTabMoveConsistent(
  session: WorkspaceSessionState,
  sourceWorktreeId: string,
  tabId: string
): void {
  const terminalRow = session.tabsByWorktree[sourceWorktreeId]?.find((tab) => tab.id === tabId)
  const unifiedTerminalTabs = findUnifiedTerminalTabs(session, sourceWorktreeId, tabId)
  // Why: a terminal row without its unified tab would persist a dest surface
  // that never enters a TabGroup / active tab, so refuse before mutation.
  if (terminalRow && unifiedTerminalTabs.length === 0) {
    throw new Error('terminal_tab_state_inconsistent')
  }
}

export function omitWorkspaceSessionWorktreeKeys(
  session: WorkspaceSessionState,
  worktreeId: string
): WorkspaceSessionState {
  const next: WorkspaceSessionState = { ...session }
  for (const field of WORKTREE_KEYED_SESSION_FIELDS) {
    const bag = session[field]
    if (!bag || !(worktreeId in bag)) {
      continue
    }
    const clone = { ...bag }
    delete clone[worktreeId]
    next[field] = clone as WorkspaceSessionState[typeof field]
  }
  return next
}

export function partitionMovedTerminalTabHostSessions(args: {
  sourceSession: WorkspaceSessionState
  destSession: WorkspaceSessionState
  sourceWorktreeId: string
  destWorktreeId: string
  tabId: string
  sameHost: boolean
}): { source: WorkspaceSessionState; dest: WorkspaceSessionState } | null {
  if (args.sameHost) {
    const moved = moveTerminalTabInWorkspaceSession(
      args.sourceSession,
      args.sourceWorktreeId,
      args.destWorktreeId,
      args.tabId
    )
    return moved.moved ? { source: moved.session, dest: moved.session } : null
  }

  const destMoved = moveTerminalTabInWorkspaceSession(
    {
      ...args.destSession,
      tabsByWorktree: {
        ...args.destSession.tabsByWorktree,
        [args.sourceWorktreeId]: args.sourceSession.tabsByWorktree[args.sourceWorktreeId]
      },
      unifiedTabs: {
        ...args.destSession.unifiedTabs,
        [args.sourceWorktreeId]: args.sourceSession.unifiedTabs?.[args.sourceWorktreeId]
      },
      tabGroups: {
        ...args.destSession.tabGroups,
        [args.sourceWorktreeId]: args.sourceSession.tabGroups?.[args.sourceWorktreeId]
      },
      tabGroupLayouts: {
        ...args.destSession.tabGroupLayouts,
        [args.sourceWorktreeId]: args.sourceSession.tabGroupLayouts?.[args.sourceWorktreeId]
      }
    },
    args.sourceWorktreeId,
    args.destWorktreeId,
    args.tabId
  )
  const sourceMoved = moveTerminalTabInWorkspaceSession(
    args.sourceSession,
    args.sourceWorktreeId,
    args.destWorktreeId,
    args.tabId
  )
  if (!destMoved.moved || !sourceMoved.moved) {
    return null
  }
  return {
    dest: omitWorkspaceSessionWorktreeKeys(destMoved.session, args.sourceWorktreeId),
    source: omitWorkspaceSessionWorktreeKeys(sourceMoved.session, args.destWorktreeId)
  }
}

export function moveTerminalTabInWorkspaceSession(
  session: WorkspaceSessionState,
  sourceWorktreeId: string,
  destWorktreeId: string,
  tabId: string
): WorkspaceSessionTerminalTabMoveResult {
  if (sourceWorktreeId === destWorktreeId) {
    return { session, moved: false }
  }
  assertWorkspaceSessionTerminalTabMoveConsistent(session, sourceWorktreeId, tabId)
  const terminalRow = session.tabsByWorktree[sourceWorktreeId]?.find((tab) => tab.id === tabId)
  const unifiedTerminalTabs = findUnifiedTerminalTabs(session, sourceWorktreeId, tabId)
  if (!terminalRow && unifiedTerminalTabs.length === 0) {
    return { session, moved: false }
  }

  const movingUnifiedIds = new Set(unifiedTerminalTabs.map((tab) => tab.id))
  movingUnifiedIds.add(tabId)
  const dest = ensureDestGroup(session, destWorktreeId)
  const destUnifiedExisting = session.unifiedTabs?.[destWorktreeId] ?? []
  const destUnifiedIds = new Set(destUnifiedExisting.map((tab) => tab.id))
  const movedUnified = unifiedTerminalTabs
    .filter((tab) => !destUnifiedIds.has(tab.id))
    .map((tab) => ({
      ...tab,
      worktreeId: destWorktreeId,
      groupId: dest.group.id
    }))
  const destTabOrder = [
    ...dest.group.tabOrder.filter((id) => !movingUnifiedIds.has(id)),
    ...movedUnified.map((tab) => tab.id)
  ]
  const destActiveTabId = movedUnified.at(-1)?.id ?? dest.group.activeTabId
  const destRecent = [
    ...(dest.group.recentTabIds ?? []).filter((id) => !movingUnifiedIds.has(id)),
    ...movedUnified.map((tab) => tab.id)
  ]
  const destGroups = dest.groups.map((group) =>
    group.id === dest.group.id
      ? {
          ...group,
          worktreeId: destWorktreeId,
          tabOrder: destTabOrder,
          activeTabId: destActiveTabId,
          recentTabIds: destRecent
        }
      : group
  )

  const sourceUnified = (session.unifiedTabs?.[sourceWorktreeId] ?? []).filter(
    (tab) => !movingUnifiedIds.has(tab.id)
  )
  const sourceGroups = (session.tabGroups?.[sourceWorktreeId] ?? [])
    .map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !movingUnifiedIds.has(id))
      const activeTabId = movingUnifiedIds.has(group.activeTabId ?? '')
        ? pickNextActiveTab(group, movingUnifiedIds)
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      return {
        ...group,
        tabOrder,
        activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => tabOrder.includes(id))
      }
    })
    .filter((group) => group.tabOrder.length > 0)
  const validSourceGroupIds = new Set(sourceGroups.map((group) => group.id))
  const sourceLayout = pruneGroupLayout(
    session.tabGroupLayouts?.[sourceWorktreeId],
    validSourceGroupIds
  )
  const sourceActiveGroupId = validSourceGroupIds.has(
    session.activeGroupIdByWorktree?.[sourceWorktreeId] ?? ''
  )
    ? session.activeGroupIdByWorktree?.[sourceWorktreeId]
    : sourceGroups[0]?.id

  const sourceTerminals = (session.tabsByWorktree[sourceWorktreeId] ?? []).filter(
    (tab) => tab.id !== tabId
  )
  const destTerminals = [
    ...(session.tabsByWorktree[destWorktreeId] ?? []).filter((tab) => tab.id !== tabId),
    ...(terminalRow ? [{ ...terminalRow, worktreeId: destWorktreeId }] : [])
  ]

  const next: WorkspaceSessionState = {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [sourceWorktreeId]: sourceTerminals,
      [destWorktreeId]: destTerminals
    },
    unifiedTabs: {
      ...session.unifiedTabs,
      [sourceWorktreeId]: sourceUnified,
      [destWorktreeId]: [...destUnifiedExisting.filter((tab) => !movingUnifiedIds.has(tab.id)), ...movedUnified]
    },
    tabGroups: {
      ...session.tabGroups,
      [sourceWorktreeId]: sourceGroups,
      [destWorktreeId]: destGroups
    },
    tabGroupLayouts: {
      ...session.tabGroupLayouts,
      ...(sourceLayout
        ? { [sourceWorktreeId]: sourceLayout }
        : {}),
      [destWorktreeId]: dest.layout
    },
    activeGroupIdByWorktree: {
      ...session.activeGroupIdByWorktree,
      [destWorktreeId]: dest.group.id
    },
    activeTabIdByWorktree: {
      ...session.activeTabIdByWorktree,
      [sourceWorktreeId]:
        session.activeTabIdByWorktree?.[sourceWorktreeId] === tabId
          ? (sourceTerminals[0]?.id ?? null)
          : (session.activeTabIdByWorktree?.[sourceWorktreeId] ?? null),
      [destWorktreeId]: terminalRow?.id ?? session.activeTabIdByWorktree?.[destWorktreeId] ?? null
    }
  }
  if (sourceLayout === undefined && next.tabGroupLayouts) {
    delete next.tabGroupLayouts[sourceWorktreeId]
  }
  if (sourceActiveGroupId) {
    next.activeGroupIdByWorktree![sourceWorktreeId] = sourceActiveGroupId
  } else if (next.activeGroupIdByWorktree) {
    delete next.activeGroupIdByWorktree[sourceWorktreeId]
  }
  if (session.activeWorktreeId === sourceWorktreeId && session.activeTabId === tabId) {
    next.activeTabId = sourceTerminals[0]?.id ?? null
  }
  return { session: next, moved: true }
}
