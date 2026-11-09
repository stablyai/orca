import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { getConnectionExecutionHostId } from '../../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { structuredAgentSessionOwnerForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'

/** Resolve the same pane owner for sidebar rows and explicit workspace reads. */
export function getAgentPaneExecutionHost(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'> &
    WorktreeRuntimeOwnerState,
  paneKey: string,
  entry: AgentStatusEntry | undefined,
  fallbackPtyId?: string | null
) {
  const tab = getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree).get(paneKey)
  if (tab) {
    return structuredAgentSessionOwnerForTab(state, tab)
  }
  const parsed = parsePaneKey(paneKey)
  const ptyId =
    (parsed && state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]) ??
    entry?.terminalHandle ??
    fallbackPtyId ??
    (parsed ? state.ptyIdsByTabId[parsed.tabId]?.[0] : undefined)
  return getPtyExecutionHost(ptyId) ?? getConnectionExecutionHostId(entry?.connectionId)
}
