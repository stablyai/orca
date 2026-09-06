import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import {
  resolveCanonicalPaneAgentIdentity,
  type ForegroundProcessProof
} from '../../../../shared/pane-agent-identity-adapter'
import { agentTypeToIconAgent } from '@/lib/agent-status'

export type TerminalTabAgentTypeState = Record<string, AgentStatusEntry>
export type TerminalTabAgentTypesByLeaf = Readonly<Record<string, AgentType>>

type SelectorDependencies = {
  onEntryVisited?: (paneKey: string) => void
}

const EMPTY_AGENT_TYPES_BY_LEAF: TerminalTabAgentTypesByLeaf = Object.freeze({})
const EMPTY_FOREGROUND_AGENT_BY_PANE_KEY: Record<string, PaneForegroundAgentEntry> = Object.freeze(
  {}
)

type PaneAgentProjectionEvidence = {
  hookAgent?: ReturnType<typeof agentTypeToIconAgent>
  completedHookAgent?: ReturnType<typeof agentTypeToIconAgent>
  processAgent?: PaneForegroundAgentEntry['agent']
  processProof?: ForegroundProcessProof | null
}

function reuseRecordIfEqual(
  previous: TerminalTabAgentTypesByLeaf | undefined,
  next: Record<string, AgentType>
): TerminalTabAgentTypesByLeaf {
  if (!previous) {
    return next
  }
  const nextKeys = Object.keys(next)
  if (Object.keys(previous).length !== nextKeys.length) {
    return next
  }
  return nextKeys.every((key) => previous[key] === next[key]) ? previous : next
}

export function createTerminalTabAgentTypeSelector(
  dependencies: SelectorDependencies = {}
): (
  state: TerminalTabAgentTypeState,
  tabId: string,
  foreground?: Record<string, PaneForegroundAgentEntry>
) => TerminalTabAgentTypesByLeaf {
  let cachedState: TerminalTabAgentTypeState | null = null
  let cachedForeground: Record<string, PaneForegroundAgentEntry> | null = null
  let cachedByTabId = new Map<string, TerminalTabAgentTypesByLeaf>()

  return (state, tabId, foreground = EMPTY_FOREGROUND_AGENT_BY_PANE_KEY) => {
    // Why: production writes replace this map. Its identity lets unrelated
    // Zustand notifications skip the global scan entirely.
    if (state !== cachedState || foreground !== cachedForeground) {
      const previousByTabId = cachedByTabId
      const evidenceByPaneKey = new Map<string, PaneAgentProjectionEvidence>()
      for (const [paneKey, entry] of Object.entries(state)) {
        dependencies.onEntryVisited?.(paneKey)
        const entryAgent = agentTypeToIconAgent(entry.agentType)
        if (!entryAgent) {
          continue
        }
        evidenceByPaneKey.set(
          paneKey,
          entry.state === 'done' ? { completedHookAgent: entryAgent } : { hookAgent: entryAgent }
        )
      }
      for (const [paneKey, entry] of Object.entries(foreground)) {
        if (!entry.agent || entry.shellForeground || entry.routingRevoked) {
          continue
        }
        const existing = evidenceByPaneKey.get(paneKey) ?? {}
        evidenceByPaneKey.set(paneKey, {
          ...existing,
          processAgent: entry.agent,
          processProof: entry.processProof
        })
      }
      const nextByTabId = new Map<string, Record<string, AgentType>>()
      for (const [paneKey, evidence] of evidenceByPaneKey) {
        const identity = resolveCanonicalPaneAgentIdentity({
          hookAgent: evidence.hookAgent,
          hookIsLive: evidence.hookAgent != null,
          completedHookAgent: evidence.completedHookAgent,
          foregroundAgent: evidence.processAgent,
          processProof: evidence.processProof
        })
        if (!identity.agent) {
          continue
        }
        const separator = paneKey.indexOf(':')
        if (separator <= 0) {
          continue
        }
        const entryTabId = paneKey.slice(0, separator)
        const leafId = paneKey.slice(separator + 1)
        const byLeaf = nextByTabId.get(entryTabId)
        if (byLeaf) {
          byLeaf[leafId] = identity.agent
        } else {
          nextByTabId.set(entryTabId, { [leafId]: identity.agent })
        }
      }

      const stabilizedByTabId = new Map<string, TerminalTabAgentTypesByLeaf>()
      for (const [entryTabId, byLeaf] of nextByTabId) {
        stabilizedByTabId.set(
          entryTabId,
          reuseRecordIfEqual(previousByTabId.get(entryTabId), byLeaf)
        )
      }
      cachedByTabId = stabilizedByTabId
      cachedState = state
      cachedForeground = foreground
    }
    return cachedByTabId.get(tabId) ?? EMPTY_AGENT_TYPES_BY_LEAF
  }
}

// Why: TerminalPane is mounted once per retained tab. Share one index so a
// store write scans the global agent map once, not once for every hidden tab.
export const selectTerminalTabAgentTypesByLeaf = createTerminalTabAgentTypeSelector()
