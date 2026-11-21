import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/ownership/terminal-tab-owner-index'

type NoticeAgent = 'codex' | 'claude'

function paneKeyTabId(paneKey: string): string {
  const separator = paneKey.indexOf(':')
  return separator === -1 ? paneKey : paneKey.slice(0, separator)
}

function isTerminalTab(state: AppState, tabId: string): boolean {
  return getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId) !== null
}

function launchedIn(tabs: readonly TerminalTab[] | undefined, agent: NoticeAgent): boolean {
  return tabs?.some((tab) => tab.launchAgent === agent) ?? false
}

// Why: the watcher saw no launched tab in `previous`, so only buckets replaced since can hold one.
function hasLaunchedTab(state: AppState, agent: NoticeAgent, previous?: AppState): boolean {
  const changes = previous ? readRecordChanges(state.tabsByWorktree, previous.tabsByWorktree) : null
  if (previous && !changes) {
    return false
  }
  if (changes?.kind === 'addressed') {
    return [...changes.keys].some((worktreeId) =>
      launchedIn(state.tabsByWorktree[worktreeId], agent)
    )
  }
  return Object.values(state.tabsByWorktree).some((tabs) => launchedIn(tabs, agent))
}

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and an agent typed in a local pane.
function hasHookAgent(
  state: AppState,
  agent: NoticeAgent,
  keys: Iterable<string> = state.agentStatusByPaneKey.keys()
): boolean {
  for (const paneKey of keys) {
    // Native chat also projects status entries, but runs no CLI in a terminal tab.
    if (
      state.agentStatusByPaneKey.get(paneKey)?.agentType === agent &&
      isTerminalTab(state, paneKeyTabId(paneKey))
    ) {
      return true
    }
  }
  return false
}

function hasForegroundAgent(state: AppState, agent: NoticeAgent, previous?: AppState): boolean {
  const entries = state.paneForegroundAgentByPaneKey
  const changes = previous
    ? readRecordChanges(entries, previous.paneForegroundAgentByPaneKey)
    : null
  return (
    (!previous || changes !== null) &&
    (changes?.kind === 'addressed'
      ? [...changes.keys].some((key) => entries[key]?.agent === agent)
      : Object.values(entries).some((entry) => entry.agent === agent))
  )
}

/** Calls `onAppear` once, as soon as a terminal running `agent` exists. Returns the unsubscribe. */
export function whenAgentTerminalAppears(agent: NoticeAgent, onAppear: () => void): () => void {
  const initial = useAppStore.getState()
  if (
    hasLaunchedTab(initial, agent) ||
    hasHookAgent(initial, agent) ||
    hasForegroundAgent(initial, agent)
  ) {
    onAppear()
    return () => {}
  }
  let projection = initial.agentStatusByPaneKey.projection
  let cursor = projection.changeCursor()
  // Why a filtered subscription: a selector would rescan every tab on each store write.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    const next = state.agentStatusByPaneKey.projection
    const keys =
      next === projection && state.tabsByWorktree === previous.tabsByWorktree
        ? next.changesSince(cursor)
        : null
    projection = next
    cursor = next.changeCursor()
    if (
      hasLaunchedTab(state, agent, previous) ||
      hasHookAgent(state, agent, keys ?? undefined) ||
      hasForegroundAgent(state, agent, previous)
    ) {
      unsubscribe()
      onAppear()
    }
  })
  return unsubscribe
}
