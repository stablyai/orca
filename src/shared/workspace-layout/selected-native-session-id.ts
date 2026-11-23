import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'

type FocusState = Pick<
  WorkspaceSessionState,
  'unifiedTabs' | 'tabGroups' | 'activeGroupIdByWorktree'
>

export function isNativeSessionFocusId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value)
}

/** Read the explicit desktop group selection; never choose a fallback tab or a paired client's navigation. */
export function selectedNativeSessionId(
  session: FocusState | null | undefined,
  worktreeId: string
): string | null | undefined {
  const activeGroupId = session?.activeGroupIdByWorktree?.[worktreeId]
  const groups = session?.tabGroups?.[worktreeId]?.filter((group) => group.id === activeGroupId)
  if (!activeGroupId || groups?.length !== 1 || !groups[0].activeTabId) {
    return undefined
  }
  const group = groups[0]
  const activeTabId = group.activeTabId
  if (group.worktreeId !== worktreeId || !activeTabId || !group.tabOrder.includes(activeTabId)) {
    return undefined
  }
  const selected = session?.unifiedTabs?.[worktreeId]?.filter(
    (tab) =>
      tab.id === group.activeTabId && tab.groupId === group.id && tab.worktreeId === worktreeId
  )
  if (selected?.length !== 1) {
    return undefined
  }
  if (selected[0].contentType !== 'agent-session') {
    return null
  }
  const id = selected[0].entityId
  return isNativeSessionFocusId(id) ? id : undefined
}

export function selectedNativeSessionIds(session: FocusState): Record<string, string | null> {
  const ids: Record<string, string | null> = {}
  for (const worktreeId of Object.keys(session.tabGroups ?? {})) {
    const id = selectedNativeSessionId(session, worktreeId)
    if (id !== undefined) {
      ids[worktreeId] = id
    }
  }
  return ids
}
