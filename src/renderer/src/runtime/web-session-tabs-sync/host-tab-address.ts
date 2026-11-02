import type { Tab } from '../../../../shared/tab-types'
import { agentSessionRowId } from '../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'
import { executionHostIdForSessionTabsOwner } from '../local-structured-session-owner'
import type { WebSessionTabsSyncState } from './state'
import { resolveHostSessionTabIdForWebSessionTab } from './tracking-mappings'

type HostTabAddressState = { unifiedTabsByWorktree?: Record<string, readonly Tab[] | undefined> }

/**
 * The host's id for a tab or terminal of this client's, as a command names it there: the last
 * applied frame's mapping, else the host tab the tab saved as the one it mirrors (`mirroredHostTab`)
 * and what it holds now (a terminal by its own id, a chat by the row it publishes). A tab's id is
 * this client's own and never read for the host's. A mirrored terminal's own id is, since this
 * client mints it from the host's terminal id alone (`toWebTerminalSurfaceTabId`). Null for a tab
 * no host publishes.
 */
export function hostTabIdOf(
  state: HostTabAddressState,
  address: { environmentId: string; worktreeId: string; tabId: string }
): string | null {
  const mapped = resolveHostSessionTabIdForWebSessionTab(state as WebSessionTabsSyncState, address)
  if (mapped) {
    return mapped
  }
  const tab = state.unifiedTabsByWorktree?.[address.worktreeId]?.find(
    (entry) => entry.id === address.tabId
  )
  if (!tab) {
    return hostTerminalIdOf(address.tabId)
  }
  if (tab.contentType === 'terminal') {
    return hostTerminalIdOf(tab.entityId)
  }
  const origin = tab.mirroredHostTab
  if (
    origin?.hostId !== executionHostIdForSessionTabsOwner(address.environmentId) ||
    origin.workspaceId !== address.worktreeId
  ) {
    return null
  }
  return tab.contentType === 'agent-session'
    ? agentSessionRowId(tab.entityId, origin.tabId)
    : origin.tabId
}

/** A mirrored terminal's id on its host; null for a terminal this client runs itself. */
function hostTerminalIdOf(terminalId: string): string | null {
  return isWebTerminalSurfaceTabId(terminalId) ? toHostSessionTabId(terminalId) : null
}
