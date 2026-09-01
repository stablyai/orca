import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentLaunchSpawnRequest } from '../../../../shared/agent-launch-spawn-request'
import { resolveTelemetryAgentKind } from '@/lib/telemetry-agent-kind'

export type QuickComposerStartupInput = {
  agent: TuiAgent | null
  prompt: string
  draftPrompt: string | null | undefined
  telemetrySource: WorktreeCreationRequest['telemetrySource']
}

export type QuickComposerStartup = {
  agentLaunch: AgentLaunchSpawnRequest | undefined
  telemetry: AgentStartedTelemetry | null
}

export function buildQuickComposerStartup(input: QuickComposerStartupInput): QuickComposerStartup {
  const { agent, draftPrompt, prompt } = input
  const agentLaunch: AgentLaunchSpawnRequest | undefined =
    agent === null
      ? undefined
      : draftPrompt
        ? {
            selection: { kind: 'agent', agent },
            prompt: draftPrompt,
            promptDelivery: 'draft'
          }
        : {
            selection: { kind: 'agent', agent },
            ...(prompt ? { prompt } : {}),
            allowEmptyPromptLaunch: true
          }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : {
          agent_kind: resolveTelemetryAgentKind(agent),
          launch_source:
            input.telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          request_kind: 'new'
        }
  return { agentLaunch, telemetry }
}
