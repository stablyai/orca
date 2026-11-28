import { structuralValuesEqualIgnoringUndefined } from '../../../../../../shared/collections/structural-value-equality'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { isWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import { chatPaneKeySessionId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

// Local completed orphans stay hidden; remote rows await host retraction, not tab hydration.
export function liveEntryWorktreeId(
  paneKey: string,
  entry: AgentStatusEntry,
  tabIdToWorktreeId: Pick<ReadonlyMap<string, string>, 'get'>,
  representedTabs?: Pick<ReadonlyMap<string, Tab>, 'get'>
): string | undefined {
  const representedTab = representedTabs?.get(paneKey)
  const parsed = parseAgentStatusPaneIdentity(paneKey, representedTab)
  if (!parsed) {
    return undefined
  }
  const tabWorktreeId = tabIdToWorktreeId.get(parsed.tabId)
  const remote = Boolean(entry.connectionId) || isWebTerminalSurfaceTabId(parsed.tabId)
  if (remote) {
    return resolveAgentStatusWorktreeId(entry, tabIdToWorktreeId) ?? undefined
  }
  if (chatPaneKeySessionId(paneKey) !== null) {
    if (!representedTab && entry.state === 'done') {
      return undefined
    }
    // The key's tab part may be an unrelated tab id.
    if (entry.worktreeId) {
      return entry.worktreeId
    }
  }
  return tabWorktreeId ?? (entry.state === 'done' ? undefined : entry.worktreeId)
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
