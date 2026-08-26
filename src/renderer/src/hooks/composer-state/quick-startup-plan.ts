import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { tuiAgentToAgentKind } from '@/lib/telemetry'

export type QuickComposerStartupInput = {
  agent: TuiAgent | null
  prompt: string
  draftPrompt: string | null | undefined
  settings: GlobalSettings | null | undefined
  repoConnectionId: string | null | undefined
  platform: NodeJS.Platform
  shell: AgentStartupShell | null | undefined
  isRemote: boolean
  telemetrySource: WorktreeCreationRequest['telemetrySource']
}

export type QuickComposerStartup = {
  startupPlan: AgentStartupPlan | null
  backendStartup: WorktreeCreationRequest['startup']
  telemetry: AgentStartedTelemetry | null
}

export function buildQuickComposerStartup(input: QuickComposerStartupInput): QuickComposerStartup {
  const { agent, draftPrompt, prompt, settings } = input
  const sessionOptions =
    agent === null
      ? undefined
      : resolveInitialNativeChatSessionOptions(
          {
            experimentalNativeChat: settings?.experimentalNativeChat,
            openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
            nativeChatSessionOptions: settings?.nativeChatSessionOptions
          },
          {
            agent,
            ...(draftPrompt
              ? { promptDelivery: 'draft' as const, launchDraftText: draftPrompt }
              : {}),
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              input.repoConnectionId
            )
          }
        )
  const draftLaunchPlan =
    agent === null || !draftPrompt
      ? null
      : buildAgentDraftLaunchPlan({
          agent,
          draft: draftPrompt,
          cmdOverrides: settings?.agentCmdOverrides ?? {},
          agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
          agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
          sessionOptions,
          platform: input.platform,
          shell: input.shell ?? undefined,
          isRemote: input.isRemote
        })
  let startupPlan: AgentStartupPlan | null = null
  if (draftLaunchPlan) {
    startupPlan = {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
      launchConfig: draftLaunchPlan.launchConfig,
      ...(draftLaunchPlan.sessionOptions ? { sessionOptions: draftLaunchPlan.sessionOptions } : {}),
      ...(draftLaunchPlan.startupCommandDelivery
        ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
        : {}),
      ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
    }
  } else if (agent !== null) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt,
      cmdOverrides: settings?.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
      sessionOptions,
      platform: input.platform,
      shell: input.shell ?? undefined,
      isRemote: input.isRemote,
      allowEmptyPromptLaunch: true
    })
    if (startupPlan && draftPrompt) {
      startupPlan.draftPrompt = draftPrompt
    }
  }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source:
            input.telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          request_kind: 'new'
        }
  const backendStartup =
    startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(agent ? { launchAgent: agent } : {}),
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          ...(telemetry ? { telemetry } : {})
        }
      : undefined
  return { startupPlan, backendStartup, telemetry }
}
