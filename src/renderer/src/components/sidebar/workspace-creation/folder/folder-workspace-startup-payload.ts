import { toAgentLaunchPreferences } from '../../../../../../shared/agent-launch/choices/agent-launch-preferences'
import type { FolderWorkspaceCreateInput } from '../../../../../../shared/folder-workspaces/folder-workspace-create'
import type { SubmitFolderWorkspaceCreateParams } from './folder-workspace-composer-submit-input'
import type { buildAgentStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import { tuiAgentToAgentKind } from '../../../../../../shared/agent-kind'
import type {
  FreshWorkspaceAgentLaunch,
  WorktreeStartupPayload
} from '@/lib/workspace/creation/worktree-startup-payload'

type FolderStartupPayloadInput = Pick<
  SubmitFolderWorkspaceCreateParams,
  'quickAgent' | 'launchInputs' | 'sessionOptions'
> & {
  prompt: string
  promptDelivery: FreshWorkspaceAgentLaunch['promptDelivery']
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
  prompt,
  promptDelivery,
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
          prompt: launchDraftPrompt ?? prompt,
          promptDelivery,
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
  quickAgent,
  agentArgs,
  sessionOptions,
  launchSource,
  prompt,
  submitPromptAfterReady,
  launchDraftPrompt
}: Pick<SubmitFolderWorkspaceCreateParams, 'quickAgent' | 'agentArgs' | 'sessionOptions'> & {
  prompt: string
  submitPromptAfterReady: boolean
  launchSource: NonNullable<SubmitFolderWorkspaceCreateParams['launchSource']>
  launchDraftPrompt: string | null
}): Partial<FolderWorkspaceCreateInput> {
  return {
    ...(launchDraftPrompt ? { startupDraft: launchDraftPrompt } : { startupPrompt: prompt }),
    ...(submitPromptAfterReady ? { startupPromptAfterReady: true } : {}),
    startupAgent: quickAgent ?? undefined,
    startupAgentArgs: agentArgs,
    startupSessionOptions: sessionOptions,
    startupLaunchPreferences: quickAgent
      ? toAgentLaunchPreferences(sessionOptions, quickAgent)
      : undefined,
    launchSource
  }
}
