import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { AI_VAULT_AGENTS } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  runNativeChatCliFork,
  useNativeChatCliForkPending
} from '../../../tab-bar/native-chat-cli-fork-run'
import {
  resolveTabSessionHistorySubject,
  resolveNativeChatCliForkIdentity,
  type NativeChatCliForkIdentity,
  type NativeChatTabSession
} from '../../../tab-bar/tab-session-history-switch'

function createExecutionHostSelector(
  tabId: string,
  worktreeId: string,
  sessionId: string,
  agent: NativeChatTabSession['agent']
) {
  let worktrees: AppState['worktreesByRepo'] | undefined
  let folders: AppState['folderWorkspaces'] | undefined
  let groups: AppState['projectGroups'] | undefined
  let repos: AppState['repos'] | undefined
  let scope: NativeChatCliForkIdentity['executionHostScope'] | null = null
  return (state: AppState) => {
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

export function useNativeChatCliHandoff(
  source: {
    tabId: string
    worktreeId: string
    nativeChat: NativeChatTabSession
  } | null
): { run: () => void; pending: boolean } | null {
  const tabId = source?.tabId
  const worktreeId = source?.worktreeId
  const sessionId = source?.nativeChat.sessionId
  const nativeAgent = source?.nativeChat.agent
  const selectExecutionHost = useMemo(
    () =>
      tabId && worktreeId && sessionId
        ? createExecutionHostSelector(tabId, worktreeId, sessionId, nativeAgent)
        : () => null,
    [tabId, worktreeId, sessionId, nativeAgent]
  )
  const executionHostScope = useAppStore(selectExecutionHost)
  const pending = useNativeChatCliForkPending(
    executionHostScope && sessionId ? { executionHostScope, sessionId } : null
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeAgent)
  const run = useCallback(() => {
    if (!tabId || !worktreeId || !sessionId || !agent) {
      return
    }
    const tab = { id: tabId, worktreeId }
    const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
      tab,
      nativeChat: { sessionId, agent }
    })
    if (subject?.kind === 'chat') {
      void runNativeChatCliFork({ subject, tab, agent, commandOverrides })
    }
  }, [tabId, worktreeId, sessionId, agent, commandOverrides])
  return executionHostScope && agent ? { run, pending } : null
}
