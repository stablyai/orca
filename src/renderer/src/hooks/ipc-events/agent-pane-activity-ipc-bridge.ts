import type { AgentPaneActivityReply } from '../../../../shared/agent-status/presentation/agent-list-status'

export function registerAgentPaneActivityIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onApplyAgentPaneActivity(({ requestId, ...change }) => {
      // Lazy: Activity's clear module binds window listeners on load. Main holds the caller's RPC open until this reply, so a throw must still answer.
      void import('@/components/activity/activity-paired-client-change')
        .then(({ applyPairedClientActivityChange }) => applyPairedClientActivityChange(change))
        .then(
          (publication): AgentPaneActivityReply => ({ requestId, publication }),
          (error: unknown): AgentPaneActivityReply => ({
            requestId,
            error: error instanceof Error ? error.message : 'agent_activity_failed'
          })
        )
        .then((reply) => window.api.ui.replyAgentPaneActivity(reply))
    })
  )
}
