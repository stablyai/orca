import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { useAppStore } from '@/store'
import { resolvePaneKeyForPtyId } from '@/runtime/runtime-terminal-inspection'

/** The hook-reported status of the pane a PTY backs; absent when the agent reports none. */
export function readAgentStatusForPtyId(ptyId: string): AgentStatusEntry | undefined {
  const state = useAppStore.getState()
  const paneKey = resolvePaneKeyForPtyId(state.terminalLayoutsByTabId, ptyId)
  return paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
}

type PaneTurnStatus = Pick<AgentStatusEntry, 'state' | 'stateStartedAt' | 'turnStartedAt'>

/**
 * Whether the row's blind retry Enter is still wanted. It must never answer a permission or
 * question prompt, and it is moot once a turn started after the first Enter. With no reported
 * status (hooks off) there is no evidence either way, so the retry stays blind, as in main.
 */
export function isSubmitRetryStillOwed(
  beforeSubmit: PaneTurnStatus | undefined,
  now: PaneTurnStatus | undefined
): boolean {
  if (!now) {
    return true
  }
  if (now.state === 'blocked' || now.state === 'waiting') {
    return false
  }
  if (now.state !== 'working') {
    return true
  }
  // Host-stamped turn clocks compared with each other, never with this renderer's clock.
  return beforeSubmit?.state === 'working' && turnStartOf(beforeSubmit) === turnStartOf(now)
}

function turnStartOf(entry: PaneTurnStatus): number {
  return entry.turnStartedAt ?? entry.stateStartedAt
}
