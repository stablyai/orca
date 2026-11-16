import type { AgentStatusEntry } from './contracts/agent-status-types'
import { isClaudeManagementTitle } from './title/agent-title-core'
import type { TerminalLayoutSnapshot } from '../workspace-layout/terminal-tab-types'

export function isTerminalTabWideFallbackSafe(
  layout: TerminalLayoutSnapshot | null | undefined
): boolean {
  if (!layout?.root) {
    return true
  }
  if (layout.root.type === 'split') {
    return false
  }
  return !layout.activeLeafId || layout.activeLeafId === layout.root.leafId
}

/** The renderer supplies its exact title input; display titles have different fallback rules. */
export function shapeMobileTerminalStatus(
  row: AgentStatusEntry | undefined,
  statusSuppressionTitle: string
): AgentStatusEntry | undefined {
  return isClaudeManagementTitle(statusSuppressionTitle) ? undefined : row
}
