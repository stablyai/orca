import { toAgentLaunchPreferences } from '../../../../../../shared/agent-launch/choices/agent-launch-preferences'
import type { FolderWorkspaceCreateInput } from '../../../../../../shared/folder-workspaces/folder-workspace-create'
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

export function buildFolderWorkspaceHostStartupPayload({
  startupPlan,
  quickAgent,
  agentArgs,
  sessionOptions,
  launchSource
}: Pick<SubmitFolderWorkspaceCreateParams, 'quickAgent' | 'agentArgs' | 'sessionOptions'> & {
  startupPlan: NonNullable<ReturnType<typeof buildAgentStartupPlan>>
  launchSource: NonNullable<SubmitFolderWorkspaceCreateParams['launchSource']>
}): Partial<FolderWorkspaceCreateInput> {
  return {
    startupCommand: startupPlan.launchCommand,
    startupEnv: startupPlan.env,
    startupLaunchConfig: startupPlan.launchConfig,
    startupCommandDelivery: startupPlan.startupCommandDelivery,
    startupAgent: quickAgent ?? undefined,
    ...(startupPlan.draftPrompt
      ? { startupPrompt: startupPlan.draftPrompt, startupPromptDelivery: 'draft' as const }
      : startupPlan.followupPrompt
        ? {
            startupPrompt: startupPlan.followupPrompt,
            startupPromptDelivery: 'auto-submit' as const
          }
        : {}),
    startupAgentArgs: agentArgs,
    startupSessionOptions: sessionOptions,
    startupLaunchPreferences: quickAgent
      ? toAgentLaunchPreferences(sessionOptions, quickAgent)
      : undefined,
    launchSource
  }
}
