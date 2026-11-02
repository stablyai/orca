/**
 * The local partition as startup reads it once WSL hosts own some of its projects: a moved
 * workspace keeps only its native chat tabs (owner decision, option C). Its terminals, editors and
 * browser tabs are retained on disk for a downgrade, but the host's partition now holds the live
 * copies under the same tab ids, so they must leave before the host partitions merge in.
 */
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../../shared/workspace-scope'
import {
  filterWorkspaceRows,
  workspaceIdsNamedByPartition
} from '../../../../shared/workspace-session-stranded-partition-adoption'
import { filterWorkspaceSessionTabs } from '../../../../shared/workspace-session-tab-filter'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { mergeWorkspaceSessionRecordField } from '../../../../shared/workspace-session-host-records'
import { isWslMovedChatTab, movedProjectForKey } from './wsl-moved-projects'

// The tab bar alone: hydration picks a chat-only workspace's focus from its groups.
const CHAT_TAB_FIELDS = [
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export function withoutWslMovedLocalRows(
  local: WorkspaceSessionState,
  projects: readonly WslMovedProject[]
): WorkspaceSessionState {
  if (projects.length === 0) {
    return local
  }
  const moved = new Set(
    [...workspaceIdsNamedByPartition(local)].filter(
      (workspaceId) => movedProjectForKey(projects, workspaceId) !== null
    )
  )
  if (moved.size === 0) {
    return local
  }
  const isMoved = (owner: string): boolean =>
    moved.has(normalizeWorkspaceSessionKeyToWorkspaceId(owner))
  const chats = filterWorkspaceSessionTabs(
    local,
    (owner, tab) => !isMoved(owner) || isWslMovedChatTab(tab)
  )
  const rest = structuredClone(filterWorkspaceRows(chats, (workspaceId) => !moved.has(workspaceId)))
  const withChats = new Set(
    Object.entries(chats.unifiedTabs ?? {}).flatMap(([owner, tabs]) =>
      isMoved(owner) && tabs.length > 0 ? [normalizeWorkspaceSessionKeyToWorkspaceId(owner)] : []
    )
  )
  const chatRows = filterWorkspaceRows(chats, (workspaceId) => withChats.has(workspaceId))
  for (const field of CHAT_TAB_FIELDS) {
    mergeWorkspaceSessionRecordField(rest, field, chatRows)
  }
  return rest
}

type SessionRead = { get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState> }

/** The session read startup hydrates from, with moved workspaces' retained local rows left out. */
export function wslMovedSessionReadApi(
  projects: readonly WslMovedProject[],
  api: SessionRead = window.api.session
): SessionRead {
  return {
    get: async (hostId) =>
      hostId === undefined ? withoutWslMovedLocalRows(await api.get(), projects) : api.get(hostId)
  }
}
