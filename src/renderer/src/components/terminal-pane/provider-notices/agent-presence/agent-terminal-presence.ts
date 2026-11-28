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
function hasAgentTerminal(state: AppState, agent: NoticeAgent, previous?: AppState): boolean {
  return (
    hasLaunchedTab(state, agent, previous) ||
    // Why the terminal-tab check: native chat (agent-session) tabs project status entries too,
    // but they run no CLI in a terminal, so they must not trigger terminal-only notices.
    Array.from(state.agentStatusByPaneKey.entries()).some(
      ([paneKey, entry]) => entry.agentType === agent && isTerminalTab(state, paneKeyTabId(paneKey))
    ) ||
    Object.values(state.paneForegroundAgentByPaneKey).some((entry) => entry.agent === agent)
  )
}

function didSourcesChange(state: AppState, previous: AppState): boolean {
  return (
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey
  )
}

/** Calls `onAppear` once, as soon as a terminal running `agent` exists. Returns the unsubscribe. */
export function whenAgentTerminalAppears(agent: NoticeAgent, onAppear: () => void): () => void {
  if (hasAgentTerminal(useAppStore.getState(), agent)) {
    onAppear()
    return () => {}
  }
  // Why a filtered subscription: a selector would rescan every tab on each store write.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (didSourcesChange(state, previous) && hasAgentTerminal(state, agent, previous)) {
      unsubscribe()
      onAppear()
    }
  })
  return unsubscribe
}

/** The wanted agent ids running in a terminal now, from the same three sources as `hasAgentTerminal`. */
function collectAgentTerminalIds(state: AppState, wanted: ReadonlySet<string>): Set<string> {
  const agents = new Set<string>()
  const take = (agent: string | null | undefined): void => {
    if (agent && wanted.has(agent)) {
      agents.add(agent)
    }
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      take(tab.launchAgent)
    }
  }
  for (const [paneKey, entry] of state.agentStatusByPaneKey.entries()) {
    if (
      entry.agentType &&
      wanted.has(entry.agentType) &&
      isTerminalTab(state, paneKeyTabId(paneKey))
    ) {
      agents.add(entry.agentType)
    }
  }
  for (const entry of Object.values(state.paneForegroundAgentByPaneKey)) {
    take(entry.agent)
  }
  return agents
}

// Why coalesced: status writes arrive per hook event and a scan walks every tab and pane.
const ARRIVAL_SCAN_MS = 1000

/**
 * Calls `onAppear` once per wanted agent id, the first time a terminal running it exists.
 * Scans only while `wanted()` is non-empty, so a settled app does no fleet-sized work. Returns the unsubscribe.
 */
export function watchAgentTerminalArrivals(
  onAppear: (agent: string) => void,
  wanted: () => ReadonlySet<string>
): () => void {
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const report = (): void => {
    timer = null
    const pending = new Set([...wanted()].filter((agent) => !seen.has(agent)))
    if (pending.size === 0) {
      return
    }
    for (const agent of collectAgentTerminalIds(useAppStore.getState(), pending)) {
      seen.add(agent)
      onAppear(agent)
    }
  }
  report()
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (timer === null && didSourcesChange(state, previous)) {
      timer = setTimeout(report, ARRIVAL_SCAN_MS)
    }
  })
  return () => {
    unsubscribe()
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
