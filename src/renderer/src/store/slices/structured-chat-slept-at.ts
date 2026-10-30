import type { StateCreator } from 'zustand'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '../types'

/** Host Sleep answers and the unidentified-owner awake fallback, by chat pane key.
 *  Written only by the status bridge, dropped with its projection, never saved. */
export type StructuredChatSleptAtByPaneKey = Readonly<Record<string, number | null>>

export type StructuredChatSleptAtSlice = {
  structuredChatSleptAtByPaneKey: StructuredChatSleptAtByPaneKey
  setStructuredChatSleptAt: (paneKey: string, sleptAt: number | null | undefined) => void
}

const EMPTY_SLEPT_CHATS: StructuredChatSleptAtByPaneKey = Object.freeze({})

function createStructuredChatPresenceSelector(
  matches: (sleptAt: number | null | undefined) => boolean
) {
  const byTabs = new WeakMap<readonly Tab[], WeakMap<StructuredChatSleptAtByPaneKey, boolean>>()
  return (
    tabs: readonly Tab[] | undefined,
    sleptAtByPaneKey: StructuredChatSleptAtByPaneKey = EMPTY_SLEPT_CHATS
  ): boolean => {
    if (!tabs?.length) {
      return false
    }
    let bySleptAt = byTabs.get(tabs)
    const cached = bySleptAt?.get(sleptAtByPaneKey)
    if (cached !== undefined) {
      return cached
    }
    const result = tabs.some(
      (tab) =>
        isStructuredTab(tab) &&
        matches(sleptAtByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)])
    )
    // Store selectors run on every write; immutable snapshots reuse scans without retaining closed tabs.
    bySleptAt ??= new WeakMap()
    bySleptAt.set(sleptAtByPaneKey, result)
    byTabs.set(tabs, bySleptAt)
    return result
  }
}

/** Missing is unknown; null keeps the chat awake for display, without proving execution. */
export const hasUnknownStructuredChat = createStructuredChatPresenceSelector(
  (sleptAt) => sleptAt === undefined
)

/** Any chat not explicitly slept, unknown included, so the dot agrees with the sleeping-workspace check. */
export const hasAwakeStructuredChat = createStructuredChatPresenceSelector(
  (sleptAt) => typeof sleptAt !== 'number'
)

export const createStructuredChatSleptAtSlice: StateCreator<
  AppState,
  [],
  [],
  StructuredChatSleptAtSlice
> = (set) => ({
  structuredChatSleptAtByPaneKey: {},
  setStructuredChatSleptAt: (paneKey, sleptAt) =>
    set((state) => {
      const current = state.structuredChatSleptAtByPaneKey
      if (current[paneKey] === sleptAt) {
        return state
      }
      const { [paneKey]: _previous, ...rest } = current
      return {
        structuredChatSleptAtByPaneKey:
          sleptAt === undefined ? rest : { ...rest, [paneKey]: sleptAt }
      }
    })
})
