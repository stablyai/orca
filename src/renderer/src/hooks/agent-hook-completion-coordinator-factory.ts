import { useAppStore } from '@/store'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator'
import type { AgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator-types'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import { createCodexAutoApprovalHookCompletionSuppressor } from '@/components/terminal-pane/codex-auto-approval-notification-suppression'
import { dispatchAgentHookTerminalLifecycle } from '@/components/terminal-pane/agent-hook-terminal-lifecycle'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export function createAgentHookCompletionCoordinator(args: {
  paneKey: string
  worktreeId: string
  authoritativeRemote: boolean
  getPtyId: () => string | null
  isLive: () => boolean
  isTrackingEnabled: () => boolean
  requiresFreshWorking: () => boolean
}): AgentCompletionCoordinator {
  const {
    paneKey,
    worktreeId,
    authoritativeRemote,
    getPtyId,
    isLive,
    isTrackingEnabled,
    requiresFreshWorking
  } = args
  return createAgentCompletionCoordinator({
    paneKey,
    statusLane: 'hook',
    getPtyId,
    getSettings: () => useAppStore.getState().settings,
    inspectProcess: async (): Promise<RuntimeTerminalProcessInspection> => ({
      foregroundProcess: null,
      hasChildProcesses: false
    }),
    dispatchHookLifecycle: (payload) => dispatchAgentHookTerminalLifecycle(paneKey, payload),
    dispatchCompletion: (title, meta) => {
      if (!isTrackingEnabled() || requiresFreshWorking()) {
        return
      }
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        suppressOsNotification: !isAgentTaskCompleteNotificationEnabled(),
        ...(authoritativeRemote && { authoritativeRemote: true }),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) => {
      if (!isTrackingEnabled() || requiresFreshWorking()) {
        return
      }
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        suppressOsNotification: !isAgentTaskCompleteNotificationEnabled(),
        ...(authoritativeRemote && { authoritativeRemote: true }),
        agentStatusSnapshot: meta.agentStatus
      })
    },
    isLive,
    // Remote status is authoritative on the host; client launch arguments may
    // describe a different or stale pane and must not suppress its attention.
    shouldSuppressHookCompletion: authoritativeRemote
      ? undefined
      : createCodexAutoApprovalHookCompletionSuppressor(paneKey)
  })
}

function isAgentTaskCompleteNotificationEnabled(): boolean {
  const n = useAppStore.getState().settings?.notifications
  return n?.enabled !== false && n?.agentTaskComplete !== false
}
