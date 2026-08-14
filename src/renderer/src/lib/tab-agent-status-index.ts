import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/tui-agent'
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
export type TabAgentPane = { readonly leafId: string; readonly agent: TuiAgent }

type TabAgentPanesByTabId = ReadonlyMap<string, readonly TabAgentPane[]>

const NO_PANES: readonly TabAgentPane[] = Object.freeze([])
const EMPTY_INDEX: TabAgentPanesByTabId = new Map()

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
let cachedStatusSource: Record<string, AgentStatusEntry> | null = null
let cachedLiveIndex: TabAgentPanesByTabId = EMPTY_INDEX
let cachedCompletedIndex: TabAgentPanesByTabId = EMPTY_INDEX

function indexAgentStatus(source: Record<string, AgentStatusEntry>): void {
  if (source === cachedStatusSource) {
    return
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
  cachedLiveIndex = live
  cachedCompletedIndex = completed
  cachedStatusSource = source
}

/** Panes of `tabId` whose agent is still running (any non-`done` state). */
export function selectLiveTabAgentPanes(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string
): readonly TabAgentPane[] {
  indexAgentStatus(agentStatusByPaneKey)
  return cachedLiveIndex.get(tabId) ?? NO_PANES
}

/** Panes of `tabId` whose agent reported `done`. */
export function selectCompletedTabAgentPanes(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string
): readonly TabAgentPane[] {
  indexAgentStatus(agentStatusByPaneKey)
  return cachedCompletedIndex.get(tabId) ?? NO_PANES
}

let cachedRetainedSource: Record<string, RetainedAgentEntry> | null = null
let cachedRetainedIndex: TabAgentPanesByTabId = EMPTY_INDEX

/** Panes of `tabId` kept as sidebar completion evidence after the row went away. */
export function selectRetainedTabAgentPanes(
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>,
  tabId: string
): readonly TabAgentPane[] {
  if (retainedAgentsByPaneKey !== cachedRetainedSource) {
    const retainedIndex = new Map<string, TabAgentPane[]>()
    for (const [paneKey, retained] of Object.entries(retainedAgentsByPaneKey)) {
      const agent = agentTypeToIconAgent(retained?.agentType)
      if (!agent) {
        continue
      }
      const parsed = parsePaneKey(paneKey)
      if (!parsed) {
        continue
      }
      appendPane(retainedIndex, parsed.tabId, { leafId: parsed.leafId, agent })
    }
    cachedRetainedIndex = retainedIndex
    cachedRetainedSource = retainedAgentsByPaneKey
  }
  return cachedRetainedIndex.get(tabId) ?? NO_PANES
}

export function firstTabAgentExcludingLeaf(
  panes: readonly TabAgentPane[],
  excludedLeafId?: string
): TuiAgent | null {
  for (const pane of panes) {
    if (pane.leafId !== excludedLeafId) {
      return pane.agent
    }
  }
  return null
}
