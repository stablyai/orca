import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  resolveNativeChatCliForkIdentity,
  type NativeChatCliForkIdentity,
  type NativeChatTabSession
} from '../tab-bar/tab-session-history-switch'

type ExecutionHostScope = NativeChatCliForkIdentity['executionHostScope']

function createExecutionHostSelector(
  tabId: string,
  worktreeId: string | null,
  sessionId: string,
  agent: NativeChatTabSession['agent']
) {
  let worktrees: AppState['worktreesByRepo'] | undefined
  let folders: AppState['folderWorkspaces'] | undefined
  let groups: AppState['projectGroups'] | undefined
  let repos: AppState['repos'] | undefined
  let scope: ExecutionHostScope | null = null
  return (state: AppState) => {
    if (!worktreeId) {
      return null
    }
    const nextWorktrees = selectWorktreesByRepo(state)
    const nextFolders = selectFolderWorkspaces(state)
    if (
      worktrees !== nextWorktrees ||
      folders !== nextFolders ||
      groups !== state.projectGroups ||
      repos !== state.repos
    ) {
      scope =
        resolveNativeChatCliForkIdentity(state, {
          tab: { id: tabId, worktreeId },
          nativeChat: { sessionId, agent }
        })?.executionHostScope ?? null
      worktrees = nextWorktrees
      folders = nextFolders
      groups = state.projectGroups
      repos = state.repos
    }
    return scope
  }
}

/** The host a chat tab's conversation runs on; re-resolved only when workspace records change,
 *  so a mounted chat does no History resolution on unrelated store writes. */
export function useNativeChatExecutionHost(
  tabId: string,
  worktreeId: string | null,
  sessionId: string,
  agent: NativeChatTabSession['agent']
): ExecutionHostScope | null {
  const select = useMemo(
    () => createExecutionHostSelector(tabId, worktreeId, sessionId, agent),
    [tabId, worktreeId, sessionId, agent]
  )
  return useAppStore(select)
}
