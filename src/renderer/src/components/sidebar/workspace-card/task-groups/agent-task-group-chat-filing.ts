import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import { structuredAgentSessionTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentTabLaunchOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-host-agents'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { canBrowseTaskGroupFolder } from './agent-task-group-workspace-key'

/** A host-published chat tab can trail its settlement; stop looking after this. */
const CHAT_TAB_WAIT_MS = 60_000

function chatTabIdFor(state: AppState, worktreeId: string, sessionId: string): string | null {
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.contentType === 'agent-session' && candidate.entityId === sessionId
  )
  return tab?.id ?? null
}

/**
 * Files a chat launched from a task group under it. A chat row is addressed either by its tab's
 * own id or, for a legacy slot tab, by the id derived from its session, so both are filed.
 */
export function fileChatInTaskGroupWhenSettled(args: {
  settlement: Promise<StructuredAgentLaunchSettlement>
  worktreeId: string
  assign: (tabId: string) => void
}): void {
  void args.settlement.then(
    (settled) => {
      if (settled.kind !== 'structured' && settled.kind !== 'visibility-unknown') {
        return
      }
      const { sessionId } = settled
      args.assign(structuredAgentSessionTabId(sessionId))
      const present = chatTabIdFor(useAppStore.getState(), args.worktreeId, sessionId)
      if (present) {
        args.assign(present)
        return
      }
      const stop = (): void => {
        clearTimeout(timer)
        unsubscribe()
      }
      const unsubscribe = useAppStore.subscribe((state) => {
        const tabId = chatTabIdFor(state, args.worktreeId, sessionId)
        if (tabId) {
          stop()
          args.assign(tabId)
        }
      })
      const timer = setTimeout(stop, CHAT_TAB_WAIT_MS)
    },
    () => {}
  )
}

/** A group folder: a local chat runs there; elsewhere the agent's terminal starts there. */
export function taskGroupFolderLaunchArgs(
  folderPath: string | undefined,
  executionHostId: ExecutionHostId | undefined
): { chatLaunchDirectory?: string; initialCwd?: string } {
  if (!folderPath) {
    return {}
  }
  return canBrowseTaskGroupFolder(executionHostId)
    ? { chatLaunchDirectory: folderPath }
    : { initialCwd: folderPath }
}

/** Files a launched session under a task group: its tab now, a chat's tab once published. */
export function fileLaunchInTaskGroup(args: {
  outcome: AgentTabLaunchOutcome
  worktreeId: string
  workspaceKey: string
  groupId: string
}): void {
  const { outcome } = args
  if (!outcome || 'refused' in outcome) {
    return
  }
  const assign = (tabId: string): void =>
    useAppStore.getState().assignTabToAgentTaskGroup(args.workspaceKey, tabId, args.groupId)
  if (outcome.surface.kind !== 'host-published') {
    assign(outcome.surface.tabId)
  }
  if (outcome.structuredSettlement) {
    fileChatInTaskGroupWhenSettled({
      settlement: outcome.structuredSettlement,
      worktreeId: args.worktreeId,
      assign
    })
  }
}
