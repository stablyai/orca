import { toast } from 'sonner'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../../shared/types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { translate } from '@/i18n/i18n'

export function buildDirectWorkItemAgentStartupPlan(args: {
  agent: TuiAgent | null
  agentArgs?: string | null
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  settings:
    | {
        agentCmdOverrides?: Partial<Record<TuiAgent, string>>
        agentDefaultArgs?: Partial<Record<TuiAgent, string>>
        agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
      }
    | null
    | undefined
  launchPlatform: NodeJS.Platform
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must not be applied for remote launches. */
  isRemote?: boolean
}): {
  startupPlan: AgentStartupPlan | null
  draftLaunchedNatively: boolean
  startupPlanFailed: boolean
} {
  if (args.agent === null) {
    return { startupPlan: null, draftLaunchedNatively: false, startupPlanFailed: false }
  }

  const effectiveAgentArgs =
    args.agentArgs === undefined
      ? resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs)
      : args.agentArgs
  const effectiveAgentEnv = resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv)
  const draftLaunchPlan =
    args.promptDelivery === 'submit-after-ready'
      ? null
      : buildAgentDraftLaunchPlan({
          agent: args.agent,
          draft: args.draftContent,
          cmdOverrides: args.settings?.agentCmdOverrides ?? {},
          platform: args.launchPlatform,
          isRemote: args.isRemote,
          agentArgs: effectiveAgentArgs,
          agentEnv: effectiveAgentEnv
        })

  if (draftLaunchPlan) {
    return {
      startupPlan: {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      },
      draftLaunchedNatively: true,
      startupPlanFailed: false
    }
  }

  const startupPlan = buildAgentStartupPlan({
    agent: args.agent,
    prompt: '',
    cmdOverrides: args.settings?.agentCmdOverrides ?? {},
    platform: args.launchPlatform,
    isRemote: args.isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv: effectiveAgentEnv,
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && args.promptDelivery === 'draft') {
    startupPlan.draftPrompt = args.draftContent
  }
  return {
    startupPlan,
    draftLaunchedNatively: false,
    startupPlanFailed: startupPlan === null
  }
}

export function buildDirectWorkItemStartupOpts(
  agent: TuiAgent | null,
  plan: AgentStartupPlan | null,
  launchSource: LaunchSource
): {
  startup?: {
    command: string
    env?: Record<string, string>
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
    draftPrompt?: string
    startupCommandDelivery?: StartupCommandDelivery
    telemetry?: AgentStartedTelemetry
  }
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
      launchConfig: plan.launchConfig,
      ...(agent ? { launchAgent: agent } : {}),
      ...(plan.draftPrompt ? { draftPrompt: plan.draftPrompt } : {}),
      ...(plan.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {}),
      ...(telemetry ? { telemetry } : {})
    }
  }
}

export function formatDirectWorkItemAgentStartTimeout(submit: boolean): string {
  // Why: "prompt" and "work item context" are grammatical parts of the
  // sentence, so each delivery mode needs a complete translation unit.
  return submit
    ? translate(
        'auto.lib.launch.work.item.direct.agent.20015b902a',
        'Agent took too long to start. The workspace is ready — paste the prompt when the agent is idle.'
      )
    : translate(
        'auto.lib.launch.work.item.direct.agent.33640ddfa0',
        'Agent took too long to start. The workspace is ready — paste the work item context when the agent is idle.'
      )
}

export async function pasteDirectWorkItemDraftWhenAgentReady(args: {
  primaryTabId: string
  startupPlan: AgentStartupPlan
  content: string
  submit?: boolean
  forcePaste?: boolean
}): Promise<void> {
  const { primaryTabId, startupPlan, content, submit = false, forcePaste = false } = args
  await deliverLaunchPromptToAgentTab({
    tabId: primaryTabId,
    content,
    agent: startupPlan.agent,
    submit,
    forcePaste,
    onTimeout: () => {
      toast.message(formatDirectWorkItemAgentStartTimeout(submit))
      // Why: process-startup timeout has no v1 enum slot; the `unknown` slice
      // on the dashboard is the trigger to add one.
      track('agent_error', {
        error_class: 'unknown',
        agent_kind: tuiAgentToAgentKind(startupPlan.agent)
      })
    }
  })
}
