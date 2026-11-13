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

export const createStructuredSessionLaunchDirectorySlice: StateCreator<
  AppState,
  [],
  [],
  StructuredSessionLaunchDirectorySlice
> = () => ({
  structuredSessionLaunchDirectoryByTabId: {}
})
