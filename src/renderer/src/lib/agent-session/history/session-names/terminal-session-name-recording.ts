import { isAiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AppState } from '@/store/types'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/ownership/terminal-tab-owner-index'
import { collectAgentPaneConversations } from '../../identity/pane-agent-conversations'
import {
  forgetTerminalSessionNames,
  hasTerminalSessionNames,
  normalizeTerminalSessionName,
  saveTerminalSessionName
} from './terminal-session-names'
import {
  bindingOf,
  deferredByTabId,
  lastSeenByTabId,
  LOCAL_TAB_NAME_WRITE_GRACE_MS,
  localNameWriteByTabId,
  namesClearedBy,
  pendingHostRenameByTabId,
  renamedFromByTabId,
  resetTerminalSessionNameStateForTest
} from './terminal-session-name-state'

/** A rename through the store: the user's act, so it names the focused pane's session now (a
 *  close right after must not lose it) and may take the name from another tab. */
export function recordTerminalTabRename(
  state: AppState,
  tabId: string,
  title: string | null,
  options: { interactive?: boolean; now?: number } = {}
): void {
  const worktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
  if (!worktreeId) {
    return
  }
  const previousName = normalizeTerminalSessionName(
    state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.customTitle
  )
  const name = normalizeTerminalSessionName(title)
  const at = options.now ?? Date.now()
  const earlier = localNameWriteByTabId.get(tabId)
  // Quick renames in a row: a stale echo may show the name before any of them.
  const earlierReplaced =
    earlier && at - earlier.at < LOCAL_TAB_NAME_WRITE_GRACE_MS ? earlier.replacedNames : []
  localNameWriteByTabId.set(tabId, {
    at,
    name,
    replacedNames: [...new Set([...earlierReplaced, previousName])].slice(-8)
  })
  deferredByTabId.delete(tabId)
  pendingHostRenameByTabId.delete(tabId)
  if (!name && !hasTerminalSessionNames()) {
    return
  }
  const conversation = collectAgentPaneConversations(state, isAiVaultAgent, {
    tab: { worktreeId, tabId }
  })[0]
  // Renames before the session is known count from the first name the tab showed (a resume's own
  // naming of an unnamed tab leaves none, so the seeded name counts). The next pass that sees the
  // session consumes it; only a saved name can ever match it.
  const shownFirst = renamedFromByTabId.get(tabId) || previousName
  if (!conversation?.providerSession.id && hasTerminalSessionNames()) {
    renamedFromByTabId.set(tabId, shownFirst)
  }
  const resolved = bindingOf(state, conversation)
  const binding = resolved === 'host-unknown' ? null : resolved
  // Only a person's rename may later name a session whose host was not known yet; a name a tab was
  // created with, or a session bound after the rename, keeps the normal rules.
  if (resolved === 'host-unknown' && name && options.interactive !== false && conversation) {
    pendingHostRenameByTabId.set(tabId, {
      sessionId: conversation.providerSession.id,
      name,
      savedAt: Date.now()
    })
  }
  if (!name) {
    forgetTerminalSessionNames(namesClearedBy(state, tabId, binding, [shownFirst, previousName]))
    return
  }
  if (binding) {
    saveTerminalSessionName({
      executionHostId: binding.executionHostId,
      sessionId: binding.providerSession.id,
      agent: binding.agent,
      tabId,
      title: name
    })
  }
}

/** A closing tab running a known session whose binding or name the last pass has not seen. Tabs
 *  with no known session have nothing a pass could save, so they never need settling. */
export function terminalTabNameUnsettled(
  state: AppState,
  worktreeId: string,
  tab: { id: string; customTitle: string | null }
): boolean {
  const conversation = collectAgentPaneConversations(state, isAiVaultAgent, {
    tab: { worktreeId, tabId: tab.id }
  })[0]
  const binding = bindingOf(state, conversation)
  if (binding === null || binding === 'host-unknown') {
    return false
  }
  const seen = lastSeenByTabId.get(tab.id)
  return seen?.key !== binding.key || seen.name !== normalizeTerminalSessionName(tab.customTitle)
}

export function resetTerminalSessionNameRecordingForTest(): void {
  resetTerminalSessionNameStateForTest()
}
