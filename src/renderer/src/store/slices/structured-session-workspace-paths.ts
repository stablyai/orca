import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

export type StructuredSessionWorkspacePath = {
  /** The session the path was published for; a tab rebound to another session must not reuse it. */
  sessionId: string
  workspacePath: string
}

/**
 * The directory the host holds each structured chat tab's session to, mirrored from the host
 * status feed. Absent means the host resolves the tab's workspace id, except for a floating chat,
 * whose directory stays unknown until its pin arrives.
 */
export type StructuredSessionWorkspacePathSlice = {
  structuredSessionWorkspacePathByTabId: Record<string, StructuredSessionWorkspacePath>
  setStructuredSessionWorkspacePath: (
    tabId: string,
    sessionId: string,
    workspacePath: string | undefined
  ) => void
  /** Only drops the entry while it still belongs to `sessionId`. */
  clearStructuredSessionWorkspacePath: (tabId: string, sessionId: string) => void
}

function withoutTab(
  byTabId: Record<string, StructuredSessionWorkspacePath>,
  tabId: string
): Record<string, StructuredSessionWorkspacePath> {
  const { [tabId]: _removed, ...rest } = byTabId
  return rest
}

export const createStructuredSessionWorkspacePathSlice: StateCreator<
  AppState,
  [],
  [],
  StructuredSessionWorkspacePathSlice
> = (set) => ({
  structuredSessionWorkspacePathByTabId: {},
  setStructuredSessionWorkspacePath: (tabId, sessionId, workspacePath) => {
    set((state) => {
      const current = state.structuredSessionWorkspacePathByTabId[tabId]
      if (!workspacePath) {
        return current
          ? {
              structuredSessionWorkspacePathByTabId: withoutTab(
                state.structuredSessionWorkspacePathByTabId,
                tabId
              )
            }
          : state
      }
      if (current?.sessionId === sessionId && current.workspacePath === workspacePath) {
        return state
      }
      return {
        structuredSessionWorkspacePathByTabId: {
          ...state.structuredSessionWorkspacePathByTabId,
          [tabId]: { sessionId, workspacePath }
        }
      }
    })
  },
  clearStructuredSessionWorkspacePath: (tabId, sessionId) => {
    set((state) =>
      state.structuredSessionWorkspacePathByTabId[tabId]?.sessionId === sessionId
        ? {
            structuredSessionWorkspacePathByTabId: withoutTab(
              state.structuredSessionWorkspacePathByTabId,
              tabId
            )
          }
        : state
    )
  }
})
