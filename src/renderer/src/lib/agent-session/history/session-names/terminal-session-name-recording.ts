import {
  isAiVaultAgent,
  type AiVaultAgent
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AppState } from '@/store/types'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/ownership/terminal-tab-owner-index'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  collectAgentPaneConversations,
  type AgentPaneConversation
} from '../../identity/pane-agent-conversations'
import {
  forgetTerminalSessionNames,
  getTerminalSessionNameEntry,
  hasTerminalSessionNames,
  normalizeTerminalSessionName,
  saveTerminalSessionName,
  terminalSessionNameKey,
  terminalSessionNameKeysOwnedBy
} from './terminal-session-names'

/** While this client's own rename echoes back through main or a paired host, the tab may still
 *  show its old name; passes leave that tab's entries alone for this long. */
export const LOCAL_TAB_NAME_WRITE_GRACE_MS = 30_000

type Binding = AgentPaneConversation<AiVaultAgent> & { key: string }

const localNameWriteByTabId = new Map<string, { at: number; name: string }>()
// What the last pass saw on each bound tab, so a pass can tell a rename made while bound.
let lastSeenByTabId = new Map<string, { key: string; name: string }>()

function bindingOf(
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

function tabIsOpen(state: AppState, tabId: string): boolean {
  return getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId) !== null
}

/** Keys a clear of `tabId` forgets: what it owns, plus its session's name left by a closed tab
 *  when the tab was showing that name (a resumed tab cleared before a pass adopted it). */
function keysClearedBy(
  state: AppState,
  tabId: string,
  binding: Binding | null,
  previousName: string
): string[] {
  const keys = terminalSessionNameKeysOwnedBy(tabId)
  if (binding && previousName) {
    const entry = getTerminalSessionNameEntry(binding.executionHostId, binding.providerSession.id)
    if (
      entry &&
      entry.tabId !== tabId &&
      entry.title === previousName &&
      !tabIsOpen(state, entry.tabId)
    ) {
      keys.push(binding.key)
    }
  }
  return keys
}

/** A rename through the store: the user's act, so it names the focused pane's session now (a
 *  close right after must not lose it) and may take the name from another tab. */
export function recordTerminalTabRename(
  state: AppState,
  tabId: string,
  title: string | null
): void {
  const worktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
  if (!worktreeId) {
    return
  }
  const previousName = normalizeTerminalSessionName(
    state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.customTitle
  )
  const name = normalizeTerminalSessionName(title)
  localNameWriteByTabId.set(tabId, { at: Date.now(), name })
  if (!name && !hasTerminalSessionNames()) {
    return
  }
  const conversation = collectAgentPaneConversations(state, isAiVaultAgent, {
    tab: { worktreeId, tabId }
  })[0]
  const resolved = bindingOf(state, conversation)
  const binding = resolved === 'host-unknown' ? null : resolved
  if (!name) {
    forgetTerminalSessionNames(keysClearedBy(state, tabId, binding, previousName))
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

export type TerminalSessionNamePassResult = {
  /** Some tab's host was not known yet; owner changes should trigger another pass. */
  hostSkipped: boolean
  /** When a write held back by the grace window becomes due, if any. */
  recheckAt: number | null
}

function tabsNamed(state: AppState): boolean {
  for (const tabs of Object.values(state.tabsByWorktree)) {
    if (tabs.some((tab) => normalizeTerminalSessionName(tab.customTitle))) {
      return true
    }
  }
  return false
}

/** Names that reach tabs without a rename here: a session id reported after the rename, and
 *  renames or clears from main, a phone or another client. */
export function reconcileTerminalSessionNames(
  state: AppState,
  now = Date.now()
): TerminalSessionNamePassResult {
  const result: TerminalSessionNamePassResult = {
    hostSkipped: false,
    recheckAt: null
  }
  for (const [tabId, write] of localNameWriteByTabId) {
    if (now - write.at >= LOCAL_TAB_NAME_WRITE_GRACE_MS) {
      localNameWriteByTabId.delete(tabId)
    }
  }
  if (!hasTerminalSessionNames() && !tabsNamed(state)) {
    return result
  }
  const tabsById = new Map<string, AppState['tabsByWorktree'][string][number]>()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      tabsById.set(tab.id, tab)
    }
  }
  const seen = new Map<string, { key: string; name: string }>()
  for (const conversation of collectAgentPaneConversations(state, isAiVaultAgent)) {
    const tab = tabsById.get(conversation.tabId)
    const binding = bindingOf(state, conversation)
    if (!tab || binding === null) {
      continue
    }
    if (binding === 'host-unknown') {
      result.hostSkipped = true
      continue
    }
    const entry = getTerminalSessionNameEntry(binding.executionHostId, binding.providerSession.id)
    const name = normalizeTerminalSessionName(tab.customTitle)
    const previous = lastSeenByTabId.get(tab.id)
    seen.set(tab.id, { key: binding.key, name })
    const owned = entry?.tabId === tab.id
    const write = localNameWriteByTabId.get(tab.id)
    if (write && write.name !== name) {
      // This client's rename has not echoed back yet; the rename already recorded the truth, and
      // the old name still showing must neither be saved again nor read as a clear.
      const due = write.at + LOCAL_TAB_NAME_WRITE_GRACE_MS
      result.recheckAt = Math.min(result.recheckAt ?? due, due)
      continue
    }
    if (write) {
      // The rename shows. It was the user's act, so it names the session even when its host was
      // not known at rename time. Grace runs its full window: a paired host's optimistic local
      // name shows at once, and a snapshot built before the host applied it may still arrive.
      if (name) {
        saveTerminalSessionName({
          executionHostId: binding.executionHostId,
          sessionId: binding.providerSession.id,
          agent: binding.agent,
          tabId: tab.id,
          title: name
        })
        continue
      }
    }
    const renamedWhileBound =
      previous !== undefined && previous.key === binding.key && previous.name !== name
    // Why not any named tab: a session resumed by hand inside a tab already named something else
    // must keep its own name. Only a tab showing that name (a resume we named) or renamed while
    // running the session takes it from a closed owner.
    const closedOwner = entry !== undefined && !owned && !tabsById.has(entry.tabId)
    if (name) {
      if (
        !entry ||
        (owned && entry.title !== name) ||
        (closedOwner && (entry.title === name || renamedWhileBound))
      ) {
        saveTerminalSessionName({
          executionHostId: binding.executionHostId,
          sessionId: binding.providerSession.id,
          agent: binding.agent,
          tabId: tab.id,
          title: name
        })
      }
    } else if (owned || (closedOwner && renamedWhileBound)) {
      forgetTerminalSessionNames(
        keysClearedBy(state, tab.id, binding, renamedWhileBound ? previous.name : '')
      )
    }
  }
  lastSeenByTabId = seen
  return result
}

export function resetTerminalSessionNameRecordingForTest(): void {
  localNameWriteByTabId.clear()
  lastSeenByTabId = new Map()
}
