import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'

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

type LaunchDirectoriesByTabId = Record<string, StructuredSessionLaunchDirectory>

function withoutTab(byTabId: LaunchDirectoriesByTabId, tabId: string): LaunchDirectoriesByTabId {
  const { [tabId]: _removed, ...rest } = byTabId
  return rest
}

export function withStructuredSessionLaunchDirectory(
  byTabId: LaunchDirectoriesByTabId,
  tabId: string,
  sessionId: string,
  launchDirectory: string | undefined
): LaunchDirectoriesByTabId {
  const current = byTabId[tabId]
  if (!launchDirectory) {
    return current ? withoutTab(byTabId, tabId) : byTabId
  }
  if (current?.sessionId === sessionId && current.launchDirectory === launchDirectory) {
    return byTabId
  }
  return { ...byTabId, [tabId]: { sessionId, launchDirectory } }
}

export function withoutStructuredSessionLaunchDirectory(
  byTabId: LaunchDirectoriesByTabId,
  tabId: string,
  sessionId: string
): LaunchDirectoriesByTabId {
  return byTabId[tabId]?.sessionId === sessionId ? withoutTab(byTabId, tabId) : byTabId
}

function launchDirectoriesPatch(
  state: AppState,
  next: LaunchDirectoriesByTabId
): Partial<AppState> | AppState {
  return next === state.structuredSessionLaunchDirectoryByTabId
    ? state
    : { structuredSessionLaunchDirectoryByTabId: next }
}

export const createStructuredSessionLaunchDirectorySlice: StateCreator<
  AppState,
  [],
  [],
  StructuredSessionLaunchDirectorySlice
> = (set) => ({
  structuredSessionLaunchDirectoryByTabId: {},
  setStructuredSessionLaunchDirectory: (tabId, sessionId, launchDirectory) => {
    set((state) =>
      launchDirectoriesPatch(
        state,
        withStructuredSessionLaunchDirectory(
          state.structuredSessionLaunchDirectoryByTabId,
          tabId,
          sessionId,
          launchDirectory
        )
      )
    )
  },
  clearStructuredSessionLaunchDirectory: (tabId, sessionId) => {
    set((state) =>
      launchDirectoriesPatch(
        state,
        withoutStructuredSessionLaunchDirectory(
          state.structuredSessionLaunchDirectoryByTabId,
          tabId,
          sessionId
        )
      )
    )
  }
})
