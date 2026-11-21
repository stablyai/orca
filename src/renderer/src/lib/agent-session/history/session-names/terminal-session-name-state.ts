import type { AiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AppState } from '@/store/types'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/ownership/terminal-tab-owner-index'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AgentPaneConversation } from '../../identity/pane-agent-conversations'
import {
  getTerminalSessionNameEntry,
  terminalSessionNameKey,
  terminalSessionNamesOwnedBy,
  type TerminalSessionNameForget
} from './terminal-session-names'

/** What the rename hook and the background pass share about tabs being named on this client. */

/** While this client's own rename echoes back through main or a paired host, the tab may still
 *  show its old name; passes leave that tab alone for this long. */
export const LOCAL_TAB_NAME_WRITE_GRACE_MS = 30_000

export type Binding = AgentPaneConversation<AiVaultAgent> & { key: string }

/** What a tab showed during this client's grace window that a pass could not yet act on. */
export type DeferredObservation = {
  executionHostId: string
  sessionId: string
  agent: AiVaultAgent
  name: string
  /** Names this client's renames replaced inside the window: seeing one again is a stale echo. */
  replacedNames: readonly string[]
  due: number
}

// This client's renames still echoing back, by tab: only to hold back stale names in passes.
export const localNameWriteByTabId = new Map<
  string,
  { at: number; name: string; replacedNames: readonly string[] }
>()
// A person's rename of a tab whose session was known but whose host was not: applied once, to that
// session, when its host resolves; never moved to another session.
export const pendingHostRenameByTabId = new Map<
  string,
  { sessionId: string; name: string; savedAt: number }
>()
// What a tab showed while its grace window held a pass back; settled when the window ends, even if
// the tab has closed by then.
export const deferredByTabId = new Map<string, DeferredObservation>()
// The name a tab showed before renames made here while no session was known (a resumed tab still
// starting). Kept until the tab's session is known or the tab closes, however long that takes.
export const renamedFromByTabId = new Map<string, string>()
// What the last pass saw on each bound tab, so a pass can tell a rename made while bound.
export const lastSeenByTabId = new Map<string, { key: string; name: string }>()

export function bindingOf(
  state: AppState,
  conversation: AgentPaneConversation<AiVaultAgent> | undefined
): Binding | 'host-unknown' | null {
  if (!conversation?.providerSession.id) {
    return null
  }
  // Why: the conversation's host falls back to local for unknown worktrees; a name saved under
  // the wrong host would show on another host's row.
  if (
    getKnownExecutionHostIdForWorktree(state, conversation.worktreeId) !==
    conversation.executionHostId
  ) {
    return 'host-unknown'
  }
  return {
    ...conversation,
    key: terminalSessionNameKey(conversation.executionHostId, conversation.providerSession.id)
  }
}

export function tabIsOpen(state: AppState, tabId: string): boolean {
  return getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId) !== null
}

/** Names a clear of `tabId` forgets: what it owns, plus its session's name left by a closed tab
 *  when the tab was showing that name (a resumed tab cleared before a pass adopted it). */
export function namesClearedBy(
  state: AppState,
  tabId: string,
  binding: Binding | null,
  shownNames: readonly string[]
): TerminalSessionNameForget[] {
  const names = terminalSessionNamesOwnedBy(tabId)
  if (binding) {
    const entry = getTerminalSessionNameEntry(binding.executionHostId, binding.providerSession.id)
    if (
      entry &&
      entry.tabId !== tabId &&
      shownNames.some((shown) => shown !== '' && shown === entry.title) &&
      !tabIsOpen(state, entry.tabId)
    ) {
      names.push({ key: binding.key, ownerTabId: entry.tabId })
    }
  }
  return names
}

/** Replaces what the last pass saw; a map shared by reference, so it is refilled in place. */
export function replaceLastSeen(next: ReadonlyMap<string, { key: string; name: string }>): void {
  lastSeenByTabId.clear()
  for (const [tabId, seen] of next) {
    lastSeenByTabId.set(tabId, seen)
  }
}

export function resetTerminalSessionNameStateForTest(): void {
  localNameWriteByTabId.clear()
  pendingHostRenameByTabId.clear()
  deferredByTabId.clear()
  renamedFromByTabId.clear()
  lastSeenByTabId.clear()
}
