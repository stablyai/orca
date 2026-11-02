import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { logicalTabIdOf } from '../../../shared/runtime-mobile-session-tab-contracts'
import { tabHolding } from './switched-tab-holding'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'

// Restart recovery for a switch whose two stores saved different halves. Main records a chat's
// tab before the window changes it (the commit point), so a window that restored tab T still
// holding the stopped terminal, while main's record names T for the chat, crashed between the two:
// T takes the chat. Only tabs this load restored are candidates, each with the terminal it held
// then; the first admitted authoritative inventory of the workspace uses them once, so no later
// frame (stale or current) ever changes a tab here. A terminal a process was bound to this run,
// even one that since exited, is never a candidate again: no PTY now does not prove none ran.

/** Per workspace: restored tab id → the terminal it held when restored. */
const candidatesByWorktree = new Map<string, Map<string, string>>()
/** Restored terminal → its candidate tab, so a run's use of it ends that candidacy. */
const candidateByTerminal = new Map<string, { worktreeId: string; tabId: string }>()

let stopWatchingBindings: (() => void) | null = null

function retireCandidate(terminalId: string): void {
  const candidate = candidateByTerminal.get(terminalId)
  candidateByTerminal.delete(terminalId)
  if (candidate) {
    candidatesByWorktree.get(candidate.worktreeId)?.delete(candidate.tabId)
  }
  if (candidateByTerminal.size === 0) {
    stopWatchingBindings?.()
    stopWatchingBindings = null
  }
}

/** Only while some restored tab is a candidate: a process bound to its terminal ends that
 *  candidacy for good, whoever bound it. */
function watchBindings(): void {
  if (stopWatchingBindings || candidateByTerminal.size === 0) {
    return
  }
  stopWatchingBindings = useAppStore.subscribe((state, prior) => {
    if (state.ptyIdsByTabId === prior.ptyIdsByTabId) {
      return
    }
    for (const terminalId of candidateByTerminal.keys()) {
      if ((state.ptyIdsByTabId[terminalId]?.length ?? 0) > 0) {
        retireCandidate(terminalId)
      }
    }
  })
}

export function captureRestoredSwitchCandidates(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeIds: Iterable<string> = Object.keys(unifiedTabsByWorktree)
): void {
  for (const worktreeId of worktreeIds) {
    for (const terminalId of candidatesByWorktree.get(worktreeId)?.values() ?? []) {
      candidateByTerminal.delete(terminalId)
    }
    const candidates = new Map<string, string>()
    for (const tab of unifiedTabsByWorktree[worktreeId] ?? []) {
      if (tab.contentType === 'terminal') {
        candidates.set(tab.id, tab.entityId)
        candidateByTerminal.set(tab.entityId, { worktreeId, tabId: tab.id })
      }
    }
    candidatesByWorktree.set(worktreeId, candidates)
  }
  watchBindings()
}

type RecoveryState = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
>

/**
 * One pass over an admitted authoritative inventory: each chat whose record names a restored tab
 * that still holds just its restored terminal, with no process this run, takes that tab (id,
 * group, place, pin and color kept). Answers the patched state and the terminals whose records go,
 * as a cleanup, once the patch lands.
 */
export function recoverRestoredSwitchedTabs<State extends RecoveryState>(
  state: State,
  snapshot: RuntimeMobileSessionTabsResult
): { state: State; retiredTerminalIds: string[] } {
  const candidates = candidatesByWorktree.get(snapshot.worktree)
  candidatesByWorktree.delete(snapshot.worktree)
  for (const terminalId of candidates?.values() ?? []) {
    retireCandidate(terminalId)
  }
  const tabs = state.unifiedTabsByWorktree[snapshot.worktree]
  if (!candidates?.size || !tabs) {
    return { state, retiredTerminalIds: [] }
  }
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
  const tabsWithLiveRows = new Set(
    snapshot.tabs.flatMap((row) =>
      row.type === 'terminal' && row.ptyId ? logicalTabIdOf(row) : []
    )
  )
  const replaced = new Map<string, Tab>()
  for (const row of snapshot.tabs) {
    const tab = row.type === 'agent-session' && row.logicalTabId && tabsById.get(row.logicalTabId)
    if (
      !tab ||
      row.type !== 'agent-session' ||
      tab.contentType !== 'terminal' ||
      candidates.get(tab.id) !== tab.entityId ||
      (state.ptyIdsByTabId[tab.entityId]?.length ?? 0) > 0 ||
      tabsWithLiveRows.has(tab.id) ||
      collectLayoutLeafIdsInOrder(state.terminalLayoutsByTabId[tab.entityId]?.root ?? null).length >
        1
    ) {
      continue
    }
    replaced.set(
      tab.id,
      tabHolding(tab, { kind: 'agent-session', sessionId: row.sessionId, agent: row.agent })
    )
  }
  if (replaced.size === 0) {
    return { state, retiredTerminalIds: [] }
  }
  return {
    state: {
      ...state,
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [snapshot.worktree]: tabs.map((tab) => replaced.get(tab.id) ?? tab)
      }
    },
    retiredTerminalIds: [...replaced.keys()].map((tabId) => tabsById.get(tabId)!.entityId)
  }
}

export function resetRestoredSwitchCandidatesForTests(): void {
  candidatesByWorktree.clear()
  candidateByTerminal.clear()
  stopWatchingBindings?.()
  stopWatchingBindings = null
}
