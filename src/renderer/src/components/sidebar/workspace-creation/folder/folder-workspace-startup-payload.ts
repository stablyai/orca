import type { SubmitFolderWorkspaceCreateParams } from './folder-workspace-composer-submit-input'
import type { buildAgentStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import { tuiAgentToAgentKind } from '../../../../../../shared/agent-kind'
import type { WorktreeStartupPayload } from '@/lib/workspace/creation/worktree-startup-payload'

type FolderStartupPayloadInput = Pick<
  SubmitFolderWorkspaceCreateParams,
  'quickAgent' | 'launchInputs' | 'sessionOptions' | 'note'
> & {
  startupPlan: ReturnType<typeof buildAgentStartupPlan> | null
  requestedAgentArgs: SubmitFolderWorkspaceCreateParams['agentArgs']
  launchDraftPrompt: string | null
  launchSource: NonNullable<SubmitFolderWorkspaceCreateParams['launchSource']>
}

export function buildFolderWorkspaceStartupPayload({
  quickAgent,
  startupPlan,
  launchInputs,
  requestedAgentArgs,
  sessionOptions,
  launchDraftPrompt,
  note,
  launchSource
}: FolderStartupPayloadInput): WorktreeStartupPayload | undefined {
  return quickAgent && startupPlan
    ? {
        command: startupPlan.launchCommand,
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        launchConfig: startupPlan.launchConfig,
        ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
        launchAgent: quickAgent,
        freshAgentLaunch: {
          agentArgs: launchInputs ? launchInputs.agentArgs : requestedAgentArgs,
          sessionOptions,
          prompt: launchDraftPrompt ?? note,
          promptDelivery: launchDraftPrompt ? ('draft' as const) : ('auto-submit' as const),
          legacy: () => ({
            startupPlan,
            pasteDraftAfterLaunch: startupPlan.draftPrompt ?? startupPlan.followupPrompt ?? null,
            submitPastedPrompt: Boolean(startupPlan.followupPrompt)
          })
        },
        ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
        ...(startupPlan.startupCommandDelivery
          ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
          : {}),
        telemetry: {
          agent_kind: tuiAgentToAgentKind(quickAgent),
          launch_source: launchSource,
          request_kind: 'new' as const
        }
      }
    : undefined
}
