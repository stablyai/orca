import type { Tab } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  deriveActiveSurface,
  pickNextActiveTabAfterClose,
  pruneGroupLayout
} from './workspace-session-active-surface'
export { pickNextActiveTabAfterClose, pruneGroupLayout } from './workspace-session-active-surface'
import { SessionUnitReader, readSessionUnit } from './session-unit-reader'
import { SessionUnitIndex } from './session-unit-index'

export type WorkspaceSessionTerminalTabCloseResult = {
  session: WorkspaceSessionState
  ptyIdsToKill: string[]
  closed: boolean
  pinned: boolean
}

function collectTabPtyIds(
  session: WorkspaceSessionState | SessionUnitReader,
  tabId: string,
  rowPtyId?: string | null
): Set<string> {
  const ids = new Set<string>()
  if (rowPtyId) {
    ids.add(rowPtyId)
  }
  for (const ptyId of Object.values(
    readSessionUnit(session, 'terminalLayoutsByTabId', tabId)?.ptyIdsByLeafId ?? {}
  )) {
    ids.add(ptyId)
  }
  const remoteSessionId = readSessionUnit(session, 'remoteSessionIdsByTabId', tabId)
  if (remoteSessionId) {
    ids.add(remoteSessionId)
  }
  return ids
}

export function findUnifiedTerminalTabs(
  session: WorkspaceSessionState | SessionUnitReader,
  worktreeId: string,
  tabId: string
): Tab[] {
  return (readSessionUnit(session, 'unifiedTabs', worktreeId) ?? []).filter(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
  )
}

/** Whether this session holds the terminal tab, as a row or a unified tab. */
export function workspaceSessionListsTerminalTab(
  session: WorkspaceSessionState | SessionUnitReader,
  worktreeId: string,
  tabId: string
): boolean {
  return (
    readSessionUnit(session, 'tabsByWorktree', worktreeId)?.some((tab) => tab.id === tabId) ===
      true || findUnifiedTerminalTabs(session, worktreeId, tabId).length > 0
  )
}

export function closeTerminalTabInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  options: { force?: boolean } = {}
): WorkspaceSessionTerminalTabCloseResult {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  const result = reduceTerminalTabClose(reader, worktreeId, tabId, options)
  return { ...result, session: reader.snapshot() }
}

export function reduceTerminalTabClose(
  session: SessionUnitReader,
  worktreeId: string,
  tabId: string,
  options: { force?: boolean } = {}
): Omit<WorkspaceSessionTerminalTabCloseResult, 'session'> {
  const terminalRow = readSessionUnit(session, 'tabsByWorktree', worktreeId)?.find(
    (tab) => tab.id === tabId
  )
  const unifiedTerminalTabs = findUnifiedTerminalTabs(session, worktreeId, tabId)
  if (!terminalRow && unifiedTerminalTabs.length === 0) {
    return { ptyIdsToKill: [], closed: false, pinned: false }
  }
  if (
    options.force !== true &&
    (terminalRow?.isPinned || unifiedTerminalTabs.some((tab) => tab.isPinned))
  ) {
    return { ptyIdsToKill: [], closed: false, pinned: true }
  }

  const closingPtyIds = collectTabPtyIds(session, tabId, terminalRow?.ptyId)
  const otherPtyIds = new Set<string>()
  for (const ptyId of closingPtyIds) {
    const tabIds = new Set(
      session.references('pty', ptyId).flatMap(({ field, key }) => {
        if (field === 'terminalLayoutsByTabId' || field === 'remoteSessionIdsByTabId') {
          return [key]
        }
        if (field === 'tabsByWorktree') {
          return (session.unit(field, key).value ?? [])
            .filter((tab) => tab.ptyId === ptyId)
            .map((tab) => tab.id)
        }
        return []
      })
    )
    if ([...tabIds].some((id) => id !== tabId && session.terminalOccurrenceCount(id) > 0)) {
      otherPtyIds.add(ptyId)
    }
  }
  const ptyIdsToKill = [...closingPtyIds].filter((ptyId) => !otherPtyIds.has(ptyId))
  const closedVisibleIds = new Set(unifiedTerminalTabs.map((tab) => tab.id))
  closedVisibleIds.add(tabId)
  const nextTabs = (readSessionUnit(session, 'unifiedTabs', worktreeId) ?? []).filter(
    (tab) => !closedVisibleIds.has(tab.id)
  )
  const nextGroups = (readSessionUnit(session, 'tabGroups', worktreeId) ?? [])
    .map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !closedVisibleIds.has(id))
      const remainingIds = new Set(tabOrder)
      const activeTabId = closedVisibleIds.has(group.activeTabId ?? '')
        ? pickNextActiveTabAfterClose(group, closedVisibleIds, tabOrder, remainingIds)
        : group.activeTabId && remainingIds.has(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      return {
        ...group,
        tabOrder,
        activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => remainingIds.has(id))
      }
    })
    .filter((group) => group.tabOrder.length > 0)
  const validGroupIds = new Set(nextGroups.map((group) => group.id))
  const priorActiveGroupId = readSessionUnit(session, 'activeGroupIdByWorktree', worktreeId)
  const nextActiveGroupId = validGroupIds.has(priorActiveGroupId ?? '')
    ? priorActiveGroupId
    : nextGroups[0]?.id
  const nextLayout = pruneGroupLayout(
    readSessionUnit(session, 'tabGroupLayouts', worktreeId),
    validGroupIds
  )

  session.write('tabsByWorktree', worktreeId, {
    present: true,
    value: (session.unit('tabsByWorktree', worktreeId).value ?? []).filter(
      (tab) => tab.id !== tabId
    )
  })
  for (const field of [
    'terminalLayoutsByTabId',
    'localOnlyScrollbackByTabId',
    'remoteSessionIdsByTabId'
  ] as const) {
    session.write(field, tabId, { present: false, value: undefined })
  }
  session.write('unifiedTabs', worktreeId, { present: true, value: nextTabs })
  session.write('tabGroups', worktreeId, { present: true, value: nextGroups })
  session.write(
    'tabGroupLayouts',
    worktreeId,
    nextLayout ? { present: true, value: nextLayout } : { present: false, value: undefined }
  )
  session.write(
    'activeGroupIdByWorktree',
    worktreeId,
    nextActiveGroupId
      ? { present: true, value: nextActiveGroupId }
      : { present: false, value: undefined }
  )
  for (const { field, key } of session.references('tab', tabId)) {
    if (field === 'sleepingAgentSessionsByPaneKey') {
      session.write(field, key, { present: false, value: undefined })
    }
  }
  for (const field of [
    'terminalLayoutsByTabId',
    'unifiedTabs',
    'tabGroups',
    'tabGroupLayouts',
    'activeGroupIdByWorktree',
    'remoteSessionIdsByTabId',
    'sleepingAgentSessionsByPaneKey'
  ] as const) {
    session.reconcileField(field, { kind: 'replacement', present: true, explicitEmpty: true })
  }
  const surface = deriveActiveSurface(session, worktreeId, nextTabs, nextGroups, nextActiveGroupId)
  session.write('activeTabIdByWorktree', worktreeId, {
    present: true,
    value: surface.terminalTabId
  })
  session.write('activeBrowserTabIdByWorktree', worktreeId, {
    present: true,
    value: surface.browserTabId
  })
  session.write('activeFileIdByWorktree', worktreeId, { present: true, value: surface.fileId })
  session.write('activeTabTypeByWorktree', worktreeId, { present: true, value: surface.type })
  if (session.field('activeWorktreeId').value === worktreeId) {
    session.replace('activeTabId', { present: true, value: surface.terminalTabId })
    const hasSurface =
      nextTabs.length > 0 ||
      (session.unit('tabsByWorktree', worktreeId).value?.length ?? 0) > 0 ||
      (session.unit('browserTabsByWorktree', worktreeId).value?.length ?? 0) > 0 ||
      (session.unit('openFilesByWorktree', worktreeId).value?.length ?? 0) > 0
    if (!hasSurface) {
      session.replace('activeWorktreeId', { present: true, value: null })
      session.replace('activeWorkspaceKey', { present: true, value: null })
      session.replace('activeWorkspaceExecutionHostId', { present: true, value: null })
    }
  }
  if ((session.unit('tabsByWorktree', worktreeId).value?.length ?? 0) === 0) {
    const members = session.field('activeWorktreeIdsOnShutdown')
    if (members.present) {
      session.replace('activeWorktreeIdsOnShutdown', {
        present: true,
        value: members.value?.filter((id) => id !== worktreeId)
      })
    }
  }
  return { ptyIdsToKill, closed: true, pinned: false }
}
