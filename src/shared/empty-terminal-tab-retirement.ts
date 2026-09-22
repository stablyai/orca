import type { WorkspaceSessionState } from './workspace-session-state-types'

export type EmptyTerminalTabRetirementRequest = {
  worktreeId: string
  tabId: string
  createdAt: number
  generation: number
}
export type EmptyTerminalTabRetirementResult =
  | { closed: true }
  | {
      closed: false
      reason:
        | 'invalid-identity'
        | 'not-local'
        | 'renderer-owned-membership'
        | 'structured-owner'
        | 'different-owner'
        | 'stale-terminal'
        | 'unrepresented-owner'
        | 'runtime-owner'
        | 'runtime-unavailable'
    }

type EmptyTerminalTabState = Pick<
  WorkspaceSessionState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'remoteSessionIdsByTabId'
  | 'terminalPtyIncarnationsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
>

export function hasTerminalTabBindingOrHistory(
  session: EmptyTerminalTabState,
  tabId: string
): boolean {
  const layout = session.terminalLayoutsByTabId[tabId]
  return Boolean(
    layout?.root ||
    layout?.activeLeafId ||
    layout?.expandedLeafId ||
    session.remoteSessionIdsByTabId?.[tabId] ||
    [layout?.ptyIdsByLeafId, layout?.buffersByLeafId, layout?.scrollbackRefsByLeafId].some(
      (map) => Object.keys(map ?? {}).length > 0
    ) ||
    Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).some((key) =>
      key.startsWith(`${tabId}:`)
    ) ||
    Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).some(
      ([key, value]) => key.startsWith(`${tabId}:`) || value.tabId === tabId
    )
  )
}

export function captureEmptyTerminalTabRetirement(
  session: EmptyTerminalTabState,
  worktreeId: string,
  tabId: string
): EmptyTerminalTabRetirementRequest | undefined {
  const tabs = Object.values(session.tabsByWorktree)
    .flat()
    .filter((tab) => tab.id === tabId)
  const row = session.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  if (
    !row ||
    tabs.length !== 1 ||
    row.worktreeId !== worktreeId ||
    row.ptyId ||
    row.isPinned ||
    row.viewMode === 'chat' ||
    (row.generation ?? 0) !== 0 ||
    hasTerminalTabBindingOrHistory(session, tabId)
  ) {
    return undefined
  }
  return { worktreeId, tabId, createdAt: row.createdAt, generation: 0 }
}

export function isEmptyTerminalTabRetirementRequest(
  value: unknown
): value is EmptyTerminalTabRetirementRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'tabId' in value &&
    typeof value.tabId === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    'generation' in value &&
    value.generation === 0
  )
}
