import { structuralValuesEqualIgnoringUndefined } from '../../../../../../shared/structural-value-equality'
import type { Tab } from '../../../../../../shared/tab-types'
import {
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { isWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'

// Local completed orphans stay hidden; remote rows await host retraction, not tab hydration.
export function liveEntryWorktreeId(
  paneKey: string,
  entry: AgentStatusEntry,
  tabIdToWorktreeId: Pick<ReadonlyMap<string, string>, 'get'>,
  representedTabs?: Pick<ReadonlyMap<string, Tab>, 'get'>
): string | undefined {
  const parsed = parseAgentStatusPaneIdentity(paneKey, representedTabs?.get(paneKey))
  if (!parsed) {
    return undefined
  }
  const tabWorktreeId = tabIdToWorktreeId.get(parsed.tabId)
  const remote = Boolean(entry.connectionId) || isWebTerminalSurfaceTabId(parsed.tabId)
  if (remote) {
    return resolveAgentStatusWorktreeId(entry, tabIdToWorktreeId) ?? undefined
  }
  return tabWorktreeId ?? (entry.state === 'done' && !remote ? undefined : entry.worktreeId)
}

/** Delivery sequence is consumed from the store by attention, never displayed in agent rows. */
export function agentRowEntriesEqual(previous: AgentStatusEntry, next: AgentStatusEntry): boolean {
  if (previous === next) {
    return true
  }
  const { acceptedStatusSeq: _previousSequence, ...previousRow } = previous
  const { acceptedStatusSeq: _nextSequence, ...nextRow } = next
  return structuralValuesEqualIgnoringUndefined(previousRow, nextRow)
}
