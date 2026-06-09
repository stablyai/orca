import { toast } from 'sonner'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'

export function buildDirectWorkItemStartupOpts(
  agent: TuiAgent | null,
  plan: AgentStartupPlan | null,
  launchSource: LaunchSource
): {
  startup?: { command: string; env?: Record<string, string>; telemetry?: AgentStartedTelemetry }
} {
  if (!plan) {
    return {}
  }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : { agent_kind: tuiAgentToAgentKind(agent), launch_source: launchSource, request_kind: 'new' }
  return {
    startup: {
      command: plan.launchCommand,
      ...(plan.env ? { env: plan.env } : {}),
      ...(telemetry ? { telemetry } : {})
    }
  }
}

export async function pasteDirectWorkItemDraftWhenAgentReady(args: {
  primaryTabId: string
  startupPlan: AgentStartupPlan
  content: string
  submit?: boolean
  forcePaste?: boolean
}): Promise<void> {
  const { primaryTabId, startupPlan, content, submit = false, forcePaste = false } = args
  await pasteDraftWhenAgentReady({
    tabId: primaryTabId,
    content,
    agent: startupPlan.agent,
    submit,
    forcePaste,
    onTimeout: () => {
      const label = submit ? 'prompt' : 'work item context'
      toast.message(
        `Agent took too long to start. The workspace is ready — paste the ${label} when the agent is idle.`
      )
      // Why: process-startup timeout has no v1 enum slot; the `unknown` slice
      // on the dashboard is the trigger to add one.
      track('agent_error', {
        error_class: 'unknown',
        agent_kind: tuiAgentToAgentKind(startupPlan.agent)
      })
    }
  })
}
