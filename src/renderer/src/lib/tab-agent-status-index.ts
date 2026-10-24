import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { agentTypeToIconAgent } from './agent-status'

/**
 * Per-tab index of icon-capable agent panes for the tab-bar resolvers in
 * `tab-agent.ts`. Without it each of ~200 mounted tabs re-scanned (and
 * re-parsed the pane key of) the whole global status map on every render.
 *
 * Panes keep the source map's insertion order because the resolvers return the
 * FIRST match — order decides which icon a split tab shows.
 */
export type TabAgentPane = { readonly leafId: string; readonly agent: TerminalAgent }

type TabAgentPanesByTabId = ReadonlyMap<string, readonly TabAgentPane[]>

const NO_PANES: readonly TabAgentPane[] = Object.freeze([])

function appendPane(index: Map<string, TabAgentPane[]>, tabId: string, pane: TabAgentPane): void {
  const panes = index.get(tabId)
  if (panes) {
    panes.push(pane)
  } else {
    index.set(tabId, [pane])
  }
}

// Why: the store replaces these maps on every write, so identity is an exact
// invalidation signal — one scan per write instead of one per tab per render.
const statusIndexes = new WeakMap<
  object,
  { live: TabAgentPanesByTabId; completed: TabAgentPanesByTabId }
>()

function indexAgentStatus(source: Record<string, AgentStatusEntry>) {
  const cached = statusIndexes.get(source)
  if (cached) {
    return cached
  }
  const live = new Map<string, TabAgentPane[]>()
  const completed = new Map<string, TabAgentPane[]>()
  for (const [paneKey, entry] of Object.entries(source)) {
    const agent = agentTypeToIconAgent(entry?.agentType)
    if (!agent) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    appendPane(entry.state === 'done' ? completed : live, parsed.tabId, {
      leafId: parsed.leafId,
      agent
    })
  }
  const result = { live, completed }
  statusIndexes.set(source, result)
  return result
}

/** Panes of `tabId` whose agent is still running (any non-`done` state). */
export function selectLiveTabAgentPanes(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string
): readonly TabAgentPane[] {
  return indexAgentStatus(agentStatusByPaneKey).live.get(tabId) ?? NO_PANES
}

/** Panes of `tabId` whose agent reported `done`. */
export function selectCompletedTabAgentPanes(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string
): readonly TabAgentPane[] {
  return indexAgentStatus(agentStatusByPaneKey).completed.get(tabId) ?? NO_PANES
}

const retainedIndexes = new WeakMap<object, TabAgentPanesByTabId>()

/** Panes of `tabId` kept as sidebar completion evidence after the row went away. */
export function selectRetainedTabAgentPanes(
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>,
  tabId: string
): readonly TabAgentPane[] {
  let retainedIndex = retainedIndexes.get(retainedAgentsByPaneKey)
  if (!retainedIndex) {
    const built = new Map<string, TabAgentPane[]>()
    for (const [paneKey, retained] of Object.entries(retainedAgentsByPaneKey)) {
      const agent = agentTypeToIconAgent(retained?.agentType)
      if (!agent) {
        continue
      }
      const parsed = parsePaneKey(paneKey)
      if (!parsed) {
        continue
      }
      appendPane(built, parsed.tabId, { leafId: parsed.leafId, agent })
    }
    retainedIndex = built
    retainedIndexes.set(retainedAgentsByPaneKey, retainedIndex)
  }
  return retainedIndex.get(tabId) ?? NO_PANES
}

export function firstTabAgentExcludingLeaf(
  panes: readonly TabAgentPane[],
  excludedLeafId?: string
): TerminalAgent | null {
  for (const pane of panes) {
    if (pane.leafId !== excludedLeafId) {
      return pane.agent
    }
  }
  return null
}
