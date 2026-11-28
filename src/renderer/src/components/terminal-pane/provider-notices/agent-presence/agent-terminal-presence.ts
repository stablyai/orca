import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import type { RecordChanges } from '@/store/record-transitions/keyed-record-transitions'
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

/** What changed since the last arrival scan; `null` keys mean that whole source must be read. */
type ArrivalDirt = {
  worktrees: Set<string> | null
  foregroundPanes: Set<string> | null
  statusRows: boolean
}

function everything(): ArrivalDirt {
  return { worktrees: null, foregroundPanes: null, statusRows: true }
}

function nothing(): ArrivalDirt {
  return { worktrees: new Set(), foregroundPanes: new Set(), statusRows: false }
}

function addKeys(target: Set<string> | null, changes: RecordChanges | null): Set<string> | null {
  if (target === null || changes === null) {
    return target
  }
  if (changes.kind !== 'addressed') {
    return null
  }
  changes.keys.forEach((key) => target.add(key))
  return target
}

/** Records one store write's relevant changes; status rows count only when a pane gains or loses one. */
function noteArrivalDirt(dirt: ArrivalDirt, state: AppState, previous: AppState): boolean {
  let changed = false
  if (state.tabsByWorktree !== previous.tabsByWorktree) {
    dirt.worktrees = addKeys(
      dirt.worktrees,
      readRecordChanges(state.tabsByWorktree, previous.tabsByWorktree)
    )
    changed = true
  }
  if (state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey) {
    dirt.foregroundPanes = addKeys(
      dirt.foregroundPanes,
      readRecordChanges(state.paneForegroundAgentByPaneKey, previous.paneForegroundAgentByPaneKey)
    )
    changed = true
  }
  // Why size only: per-hook status updates rewrite rows in place; a new agent pane adds a row.
  if (state.agentStatusByPaneKey.size !== previous.agentStatusByPaneKey.size) {
    dirt.statusRows = true
    changed = true
  }
  return changed
}

/** Wanted agent ids running in a terminal of an accepted workspace, read only where `dirt` says. */
function collectAgentTerminalIds(
  state: AppState,
  wanted: ReadonlySet<string>,
  acceptWorktree: (state: AppState, worktreeId: string) => boolean,
  dirt: ArrivalDirt
): Set<string> {
  const agents = new Set<string>()
  const acceptPane = (paneKey: string): boolean => {
    const worktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, paneKeyTabId(paneKey))
    return worktreeId !== null && acceptWorktree(state, worktreeId)
  }
  for (const worktreeId of dirt.worktrees ?? Object.keys(state.tabsByWorktree)) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      if (tab.launchAgent && wanted.has(tab.launchAgent) && acceptWorktree(state, worktreeId)) {
        agents.add(tab.launchAgent)
      }
    }
  }
  // A pane key only counts when it belongs to a terminal tab; native chat tabs run no CLI.
  if (dirt.statusRows) {
    for (const [paneKey, entry] of state.agentStatusByPaneKey.entries()) {
      if (entry.agentType && wanted.has(entry.agentType) && acceptPane(paneKey)) {
        agents.add(entry.agentType)
      }
    }
  }
  for (const paneKey of dirt.foregroundPanes ?? Object.keys(state.paneForegroundAgentByPaneKey)) {
    const agent = state.paneForegroundAgentByPaneKey[paneKey]?.agent
    if (agent && wanted.has(agent) && acceptPane(paneKey)) {
      agents.add(agent)
    }
  }
  return agents
}

// Why coalesced: tab and pane writes can arrive in bursts; one read per window is enough for a card.
const ARRIVAL_SCAN_MS = 1000

/**
 * Calls `onAppear` once per wanted agent id, the first time a terminal running it exists.
 * After one full read it reads only what changed (new tabs, panes' foreground agents, added status
 * rows), and nothing once `wanted()` is satisfied. Returns the unsubscribe.
 */
export function watchAgentTerminalArrivals(
  onAppear: (agent: string) => void,
  wanted: () => ReadonlySet<string>,
  acceptWorktree: (state: AppState, worktreeId: string) => boolean = () => true
): () => void {
  const seen = new Set<string>()
  // Agents already read for in full; a newly wanted agent needs one full read of its own.
  const fullyRead = new Set<string>()
  let dirt = nothing()
  let timer: ReturnType<typeof setTimeout> | null = null
  const pendingAgents = (): Set<string> =>
    new Set([...wanted()].filter((agent) => !seen.has(agent)))
  const report = (): void => {
    timer = null
    const pending = pendingAgents()
    const needsFullRead = [...pending].some((agent) => !fullyRead.has(agent))
    const scope = needsFullRead ? everything() : dirt
    dirt = nothing()
    pending.forEach((agent) => fullyRead.add(agent))
    if (pending.size === 0) {
      return
    }
    for (const agent of collectAgentTerminalIds(
      useAppStore.getState(),
      pending,
      acceptWorktree,
      scope
    )) {
      seen.add(agent)
      onAppear(agent)
    }
  }
  report()
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    // Nothing to find: keep no per-key record (it would grow with every pane ever touched);
    // a later wanted agent gets its own full read instead.
    if (pendingAgents().size === 0) {
      dirt = nothing()
      fullyRead.clear()
      return
    }
    const changed = noteArrivalDirt(dirt, state, previous)
    if (
      timer === null &&
      (changed || state.localDetectedAgentIdsByContext !== previous.localDetectedAgentIdsByContext)
    ) {
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
