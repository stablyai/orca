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

export function isStructuredChatSlept(
  sleptAtByPaneKey: StructuredChatSleptAtByPaneKey,
  tab: { id: string; entityId: string }
): boolean {
  return typeof sleptAtByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)] === 'number'
}

/** Missing is unknown; null keeps the chat awake for display, without proving execution. */
export function hasUnknownStructuredChat(
  tabs: readonly Tab[] | undefined,
  sleptAtByPaneKey: StructuredChatSleptAtByPaneKey = {}
): boolean {
  return (tabs ?? []).some(
    (tab) =>
      isStructuredTab(tab) &&
      sleptAtByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)] === undefined
  )
}

/** Any chat not explicitly slept, unknown included, so the dot agrees with the sleeping-workspace check. */
export function hasAwakeStructuredChat(
  tabs: readonly Tab[] | undefined,
  sleptAtByPaneKey: StructuredChatSleptAtByPaneKey = {}
): boolean {
  return (tabs ?? []).some(
    (tab) => isStructuredTab(tab) && !isStructuredChatSlept(sleptAtByPaneKey, tab)
  )
}

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
