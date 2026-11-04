import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

export type StructuredSessionLaunchDirectory = {
  /** The session the path was published for; a tab rebound to another session must not reuse it. */
  sessionId: string
  launchDirectory: string
}

/** Mirror host-pinned chat directories; absent uses workspace resolution except floating chats, which remain unknown until pinned. */
export type StructuredSessionLaunchDirectorySlice = {
  structuredSessionLaunchDirectoryByTabId: Record<string, StructuredSessionLaunchDirectory>
  setStructuredSessionLaunchDirectory: (
    tabId: string,
    sessionId: string,
    launchDirectory: string | undefined
  ) => void
  /** Only drops the entry while it still belongs to `sessionId`. */
  clearStructuredSessionLaunchDirectory: (tabId: string, sessionId: string) => void
}

function withoutTab(
  byTabId: Record<string, StructuredSessionLaunchDirectory>,
  tabId: string
): Record<string, StructuredSessionLaunchDirectory> {
  const { [tabId]: _removed, ...rest } = byTabId
  return rest
}

export const createStructuredSessionLaunchDirectorySlice: StateCreator<
  AppState,
  [],
  [],
  StructuredSessionLaunchDirectorySlice
> = (set) => ({
  structuredSessionLaunchDirectoryByTabId: {},
  setStructuredSessionLaunchDirectory: (tabId, sessionId, launchDirectory) => {
    set((state) => {
      const current = state.structuredSessionLaunchDirectoryByTabId[tabId]
      if (!launchDirectory) {
        return current
          ? {
              structuredSessionLaunchDirectoryByTabId: withoutTab(
                state.structuredSessionLaunchDirectoryByTabId,
                tabId
              )
            }
          : state
      }
      if (current?.sessionId === sessionId && current.launchDirectory === launchDirectory) {
        return state
      }
      return {
        structuredSessionLaunchDirectoryByTabId: {
          ...state.structuredSessionLaunchDirectoryByTabId,
          [tabId]: { sessionId, launchDirectory }
        }
      }
    })
  },
  clearStructuredSessionLaunchDirectory: (tabId, sessionId) => {
    set((state) =>
      state.structuredSessionLaunchDirectoryByTabId[tabId]?.sessionId === sessionId
        ? {
            structuredSessionLaunchDirectoryByTabId: withoutTab(
              state.structuredSessionLaunchDirectoryByTabId,
              tabId
            )
          }
        : state
    )
  }
})
