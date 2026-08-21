import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { deriveGeneratedTabTitle } from '../../../../shared/agent-tab-title'

export type TerminalTabAgentStatusState = Record<string, AgentStatusEntry>
export type GeneratedPaneTitlesByLeaf = Readonly<Record<string, string>>

export const EMPTY_GENERATED_PANE_TITLES: GeneratedPaneTitlesByLeaf = Object.freeze({})

function reuseRecordIfEqual(
  previous: GeneratedPaneTitlesByLeaf | undefined,
  next: Record<string, string>
): GeneratedPaneTitlesByLeaf {
  if (!previous) {
    return next
  }
  const nextKeys = Object.keys(next)
  if (Object.keys(previous).length !== nextKeys.length) {
    return next
  }
  return nextKeys.every((key) => previous[key] === next[key]) ? previous : next
}

export function createTerminalTabGeneratedPaneTitleSelector(): (
  state: TerminalTabAgentStatusState,
  tabId: string
) => GeneratedPaneTitlesByLeaf {
  let cachedState: TerminalTabAgentStatusState | null = null
  let cachedByTabId = new Map<string, GeneratedPaneTitlesByLeaf>()
  // Why: setAgentStatus is high-frequency and most writes carry the same prompt,
  // so the derivation is memoized per pane and only reruns when its prompt moves.
  let cachedTitleByPaneKey = new Map<string, { prompt: string; title: string | null }>()

  return (state, tabId) => {
    // Why: production writes replace this map. Its identity lets unrelated
    // Zustand notifications skip the global scan entirely.
    if (state !== cachedState) {
      const previousByTabId = cachedByTabId
      const previousTitleByPaneKey = cachedTitleByPaneKey
      const nextTitleByPaneKey = new Map<string, { prompt: string; title: string | null }>()
      const nextByTabId = new Map<string, Record<string, string>>()
      for (const [paneKey, entry] of Object.entries(state)) {
        const prompt = entry.prompt
        if (!prompt) {
          continue
        }
        const separator = paneKey.indexOf(':')
        if (separator <= 0) {
          continue
        }
        const memoized = previousTitleByPaneKey.get(paneKey)
        const derived =
          memoized?.prompt === prompt
            ? memoized
            : { prompt, title: deriveGeneratedTabTitle(prompt) }
        nextTitleByPaneKey.set(paneKey, derived)
        if (!derived.title) {
          continue
        }
        const entryTabId = paneKey.slice(0, separator)
        const leafId = paneKey.slice(separator + 1)
        const byLeaf = nextByTabId.get(entryTabId)
        if (byLeaf) {
          byLeaf[leafId] = derived.title
        } else {
          nextByTabId.set(entryTabId, { [leafId]: derived.title })
        }
      }

      const stabilizedByTabId = new Map<string, GeneratedPaneTitlesByLeaf>()
      for (const [entryTabId, byLeaf] of nextByTabId) {
        stabilizedByTabId.set(
          entryTabId,
          reuseRecordIfEqual(previousByTabId.get(entryTabId), byLeaf)
        )
      }
      cachedByTabId = stabilizedByTabId
      cachedTitleByPaneKey = nextTitleByPaneKey
      cachedState = state
    }
    return cachedByTabId.get(tabId) ?? EMPTY_GENERATED_PANE_TITLES
  }
}

// Why: TerminalPane is mounted once per retained tab. Share one index so a
// store write derives each pane's title once, not once for every hidden tab.
export const selectTerminalTabGeneratedPaneTitles = createTerminalTabGeneratedPaneTitleSelector()
