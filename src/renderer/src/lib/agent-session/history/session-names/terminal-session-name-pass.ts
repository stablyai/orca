import { isAiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AppState } from '@/store/types'
import { collectAgentPaneConversations } from '../../identity/pane-agent-conversations'
import {
  forgetTerminalSessionNames,
  getTerminalSessionNameEntry,
  hasTerminalSessionNames,
  normalizeTerminalSessionName,
  saveTerminalSessionName,
  terminalSessionNamesOwnedBy
} from './terminal-session-names'
import {
  LOCAL_TAB_NAME_WRITE_GRACE_MS,
  bindingOf,
  deferredByTabId,
  lastSeenByTabId,
  localNameWriteByTabId,
  namesClearedBy,
  pendingHostRenameByTabId,
  renamedFromByTabId,
  replaceLastSeen,
  tabIsOpen
} from './terminal-session-name-state'

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

/** Settles what tabs showed during a grace window once it ends, for tabs that closed meanwhile.
 *  An open tab is looked at again by the pass itself. */
function settleDeferredOfClosedTabs(
  state: AppState,
  now: number,
  result: TerminalSessionNamePassResult
): void {
  for (const [tabId, deferred] of deferredByTabId) {
    if (tabIsOpen(state, tabId)) {
      continue
    }
    if (now < deferred.due) {
      result.recheckAt = Math.min(result.recheckAt ?? deferred.due, deferred.due)
      continue
    }
    deferredByTabId.delete(tabId)
    const entry = getTerminalSessionNameEntry(deferred.executionHostId, deferred.sessionId)
    // Not a stale echo of what this client's renames replaced, and only the tab's own name (one
    // moved to another tab since stays with it), or a new name where none is saved.
    if (
      deferred.replacedNames.includes(deferred.name) ||
      (entry ? entry.tabId !== tabId : !deferred.name)
    ) {
      continue
    }
    if (deferred.name) {
      saveTerminalSessionName({
        executionHostId: deferred.executionHostId,
        sessionId: deferred.sessionId,
        agent: deferred.agent,
        tabId,
        title: deferred.name
      })
    } else {
      forgetTerminalSessionNames(terminalSessionNamesOwnedBy(tabId))
    }
  }
}

/** Names that reach tabs without a rename here: a session id reported after the rename, and
 *  renames or clears from main, a phone or another client. `onlyTabIds` limits the pass to tabs
 *  that are closing, leaving what it remembers about every other tab for the next full pass. */
export function reconcileTerminalSessionNames(
  state: AppState,
  now = Date.now(),
  options: { onlyTabIds?: ReadonlySet<string> } = {}
): TerminalSessionNamePassResult {
  const result: TerminalSessionNamePassResult = {
    hostSkipped: false,
    recheckAt: null
  }
  const only = options.onlyTabIds
  for (const [tabId, write] of localNameWriteByTabId) {
    if (now - write.at >= LOCAL_TAB_NAME_WRITE_GRACE_MS) {
      localNameWriteByTabId.delete(tabId)
    }
  }
  for (const map of [renamedFromByTabId, pendingHostRenameByTabId]) {
    for (const tabId of map.keys()) {
      if (!tabIsOpen(state, tabId)) {
        map.delete(tabId)
      }
    }
  }
  if (!only) {
    settleDeferredOfClosedTabs(state, now, result)
  }
  if (!hasTerminalSessionNames() && !tabsNamed(state)) {
    if (!only) {
      // Nothing is named, so nothing seen before still matters; a stale view would make a name
      // that arrives later look settled to the close-time check.
      lastSeenByTabId.clear()
    }
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
    if (only && !only.has(conversation.tabId)) {
      continue
    }
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
      // This client's rename has not echoed back yet, so the name showing may be stale or a change
      // made elsewhere; decide once the window ends, even if the tab closes first.
      const due = write.at + LOCAL_TAB_NAME_WRITE_GRACE_MS
      deferredByTabId.set(tab.id, {
        executionHostId: binding.executionHostId,
        sessionId: binding.providerSession.id,
        agent: binding.agent,
        name,
        replacedNames: write.replacedNames,
        due
      })
      result.recheckAt = Math.min(result.recheckAt ?? due, due)
      continue
    }
    deferredByTabId.delete(tab.id)
    // The session is known now; what the tab showed before renames made while starting decides
    // below whether it takes the session's saved name.
    const renamedFrom = renamedFromByTabId.get(tab.id)
    renamedFromByTabId.delete(tab.id)
    // A person's rename made while this session's host was unknown names it once the host is known
    // and the tab shows that name; it never names a different session.
    const pending = pendingHostRenameByTabId.get(tab.id)
    pendingHostRenameByTabId.delete(tab.id)
    if (
      pending?.sessionId === binding.providerSession.id &&
      pending.name === name &&
      // A name another tab or window saved for this session since then is newer and stands.
      !(entry && !owned && entry.savedAt > pending.savedAt)
    ) {
      saveTerminalSessionName({
        executionHostId: binding.executionHostId,
        sessionId: binding.providerSession.id,
        agent: binding.agent,
        tabId: tab.id,
        title: name
      })
      continue
    }
    const renamedWhileBound =
      previous !== undefined && previous.key === binding.key && previous.name !== name
    // Why not any named tab: a session resumed by hand inside a tab already named something else
    // must keep its own name. Only a tab showing that name (a resume we named), renamed while
    // running the session, or renamed here from that name takes it from a closed owner.
    const closedOwner = entry !== undefined && !owned && !tabsById.has(entry.tabId)
    const renamedFromSavedName = renamedFrom !== undefined && renamedFrom === entry?.title
    if (name) {
      if (
        !entry ||
        (owned && entry.title !== name) ||
        (closedOwner && (entry.title === name || renamedWhileBound || renamedFromSavedName))
      ) {
        saveTerminalSessionName({
          executionHostId: binding.executionHostId,
          sessionId: binding.providerSession.id,
          agent: binding.agent,
          tabId: tab.id,
          title: name
        })
      }
    } else if (owned || (closedOwner && (renamedWhileBound || renamedFromSavedName))) {
      const shownBeforeClear = [
        renamedFromSavedName ? renamedFrom : '',
        renamedWhileBound ? previous.name : ''
      ]
      forgetTerminalSessionNames(namesClearedBy(state, tab.id, binding, shownBeforeClear))
    }
  }
  if (only) {
    // These tabs are closing; nothing seen of them matters to later passes.
    for (const tabId of only) {
      lastSeenByTabId.delete(tabId)
    }
  } else {
    replaceLastSeen(seen)
  }
  return result
}
