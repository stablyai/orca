import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'

export type TerminalTabAgentTypeState = Record<string, AgentStatusEntry>
export type TerminalTabAgentTypesByLeaf = Readonly<Record<string, AgentType>>

type SelectorDependencies = {
  onEntryVisited?: (paneKey: string) => void
}

const EMPTY_AGENT_TYPES_BY_LEAF: TerminalTabAgentTypesByLeaf = Object.freeze({})

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
): (state: TerminalTabAgentTypeState, tabId: string) => TerminalTabAgentTypesByLeaf {
  let cachedState: TerminalTabAgentTypeState | null = null
  let cachedByTabId = new Map<string, TerminalTabAgentTypesByLeaf>()

  return (state, tabId) => {
    // Why: production writes replace this map. Its identity lets unrelated
    // Zustand notifications skip the global scan entirely.
    if (state !== cachedState) {
      const previousByTabId = cachedByTabId
      const nextByTabId = new Map<string, Record<string, AgentType>>()
      for (const [paneKey, entry] of Object.entries(state)) {
        dependencies.onEntryVisited?.(paneKey)
        if (!entry.agentType) {
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
          byLeaf[leafId] = entry.agentType
        } else {
          nextByTabId.set(entryTabId, { [leafId]: entry.agentType })
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
    }
    return cachedByTabId.get(tabId) ?? EMPTY_AGENT_TYPES_BY_LEAF
  }
}

// Why: TerminalPane is mounted once per retained tab. Share one index so a
// store write scans the global agent map once, not once for every hidden tab.
export const selectTerminalTabAgentTypesByLeaf = createTerminalTabAgentTypeSelector()
