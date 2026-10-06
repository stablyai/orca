import { toast } from 'sonner'
import { showAgentLaunchPromptNotDeliveredNotice } from '@/lib/agent-launch-prompt-not-delivered-notice'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab,
  seedNativeChatLaunchPromptForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  planLaunchPrompt,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { translate } from '@/i18n/i18n'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import type { PersistedNativeChatSessionOptions } from '../../../shared/native-chat-session-options'
import type { LaunchFile, UnstageableLine } from '../../../shared/launch-prompt-file'
import type { LaunchHost } from '../../../shared/launch-host'

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
        experimentalNativeChat?: boolean
        openAgentTabsInChatByDefault?: boolean
        nativeChatSessionOptions?: PersistedNativeChatSessionOptions
      }
    | null
    | undefined
  launchPlatform: NodeJS.Platform
  nativeChatTranscriptIsLocalReadable?: boolean
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must not be applied for remote launches. */
  isRemote?: boolean
  /** The host the launch runs on (`clientLaunchHost`). */
  host: LaunchHost
}): {
  startupPlan: AgentStartupPlan | null
  launchFile?: LaunchFile
  /** The submitted prompt the launch command carries (on its line or in `launchFile`). */
  launchPrompt?: string
  /** The rule's wish for a line the host cannot stage, sent with the spawn. */
  unstageableLine?: UnstageableLine
  /** The launch command carries the content (a native draft or a submitted prompt); no paste runs. */
  promptOnLaunchCommand: boolean
  startupPlanFailed: boolean
} {
  if (args.agent === null) {
    return { startupPlan: null, promptOnLaunchCommand: false, startupPlanFailed: false }
  }

  const effectiveAgentArgs =
    args.agentArgs === undefined
      ? resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs)
      : args.agentArgs
  const effectiveAgentEnv = resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv)
  const sessionOptions = resolveInitialNativeChatSessionOptions(args.settings, {
    agent: args.agent,
    ...(args.promptDelivery === 'draft'
      ? { promptDelivery: 'draft' as const, launchDraftText: args.draftContent }
      : {}),
    nativeChatTranscriptIsLocalReadable: args.nativeChatTranscriptIsLocalReadable
  })
  const planInputs = {
    agent: args.agent,
    cmdOverrides: args.settings?.agentCmdOverrides ?? {},
    platform: args.launchPlatform,
    isRemote: args.isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv: effectiveAgentEnv,
    sessionOptions
  }
  if (args.promptDelivery === 'submit-after-ready') {
    const planned = planLaunchPrompt({
      ...planInputs,
      prompt: args.draftContent,
      host: args.host,
      paste: 'once-agent-runs'
    })
    if (!planned) {
      return { startupPlan: null, promptOnLaunchCommand: false, startupPlanFailed: true }
    }
    switch (planned.carry) {
      case 'none':
        return { startupPlan: planned.plan, promptOnLaunchCommand: true, startupPlanFailed: false }
      case 'on-line':
        return {
          startupPlan: planned.plan,
          launchPrompt: args.draftContent,
          ...(planned.unstageableLine ? { unstageableLine: planned.unstageableLine } : {}),
          promptOnLaunchCommand: true,
          startupPlanFailed: false
        }
      case 'launch-file':
        return {
          startupPlan: planned.plan,
          launchFile: planned.launchFile,
          launchPrompt: args.draftContent,
          promptOnLaunchCommand: true,
          startupPlanFailed: false
        }
      case 'paste-after-ready':
        return {
          startupPlan: planned.cleanPlan,
          promptOnLaunchCommand: false,
          startupPlanFailed: false
        }
    }
  }
  const draftLaunchPlan = buildAgentDraftLaunchPlan({
    agent: args.agent,
    draft: args.draftContent,
    cmdOverrides: args.settings?.agentCmdOverrides ?? {},
    platform: args.launchPlatform,
    isRemote: args.isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv: effectiveAgentEnv,
    sessionOptions
  })

  if (draftLaunchPlan) {
    return {
      startupPlan: {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.sessionOptions
          ? { sessionOptions: draftLaunchPlan.sessionOptions }
          : {}),
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      },
      promptOnLaunchCommand: true,
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
    sessionOptions,
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && args.promptDelivery === 'draft') {
    startupPlan.draftPrompt = args.draftContent
  }
  return {
    startupPlan,
    promptOnLaunchCommand: false,
    startupPlanFailed: startupPlan === null
  }
}

export function buildDirectWorkItemStartupOpts(
  agent: TuiAgent | null,
  plan: AgentStartupPlan | null,
  launchSource: LaunchSource,
  /** Unsent launch context, for the view-mode decision only. Set it for every
   *  draft launch — a natively-prefilled plan carries no `draftPrompt`. */
  launchDraftText?: string,
  /** What the launch command carries: its launch file, and the submitted prompt (see
   *  `PtyPaneStartup.launchPrompt`). */
  carried: {
    launchFile?: LaunchFile
    launchPrompt?: string
    unstageableLine?: UnstageableLine
  } = {}
): {
  startup?: {
    command: string
    env?: Record<string, string>
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
    draftPrompt?: string
    launchDraftText?: string
    sessionOptions?: AgentStartupPlan['sessionOptions']
    startupCommandDelivery?: StartupCommandDelivery
    launchFile?: LaunchFile
    launchPrompt?: string
    unstageableLine?: UnstageableLine
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
      ...(plan.sessionOptions ? { sessionOptions: plan.sessionOptions } : {}),
      ...(agent ? { launchAgent: agent } : {}),
      ...(plan.draftPrompt ? { draftPrompt: plan.draftPrompt } : {}),
      ...(launchDraftText ? { launchDraftText } : {}),
      ...(plan.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {}),
      ...(carried.launchFile ? { launchFile: carried.launchFile } : {}),
      ...(carried.launchPrompt ? { launchPrompt: carried.launchPrompt } : {}),
      ...(carried.unstageableLine ? { unstageableLine: carried.unstageableLine } : {}),
      ...(telemetry ? { telemetry } : {})
    }
  }
}

/** Timeout notice for the post-launch paste; the workspace itself is ready. */
export function notifyDirectWorkItemAgentStartTimeout(agent: TuiAgent, submit: boolean): void {
  toast.message(
    translate(
      'auto.lib.launch.work.item.direct.agent.ceeeb509b5',
      'Agent took too long to start. The workspace is ready — paste the {{value0}} when the agent is idle.',
      { value0: submit ? 'prompt' : 'work item context' }
    )
  )
  // Why: process-startup timeout has no v1 enum slot; the `unknown` slice
  // on the dashboard is the trigger to add one.
  track('agent_error', { error_class: 'unknown', agent_kind: tuiAgentToAgentKind(agent) })
}

/** The work item's text once its agent tab exists: mirrored into chat where the launch carried it,
 *  else pasted once the agent is ready. */
export function deliverDirectWorkItemPrompt(args: {
  tabId: string
  agent: TuiAgent | null
  startupPlan: Pick<AgentStartupPlan, 'agent' | 'draftPrompt'> | null
  promptDelivery: 'draft' | 'submit-after-ready'
  content: string
  promptOnLaunchCommand: boolean
  promptInLaunchFile: boolean
}): void {
  const { tabId, agent, startupPlan, promptDelivery, content } = args
  if (agent && promptDelivery === 'draft') {
    // Why: the draft rides in on argv or the startup payload, so no paste runs
    // below; mirror it into chat the way the new-tab launcher does.
    seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text: content })
  }
  if (
    agent &&
    promptDelivery === 'submit-after-ready' &&
    args.promptOnLaunchCommand &&
    // Why: the transcript then shows the pointer sentence, which would never prune this copy.
    !args.promptInLaunchFile
  ) {
    // Why: the launch line submits it, so no paste seeds the chat's copy of the prompt.
    seedNativeChatLaunchPromptForAgentTab({ tabId, agent, text: content })
  }
  if (
    startupPlan &&
    !args.promptOnLaunchCommand &&
    !(promptDelivery === 'draft' && startupPlan.draftPrompt)
  ) {
    const submit = promptDelivery === 'submit-after-ready'
    const launched = startupPlan.agent
    void deliverLaunchPromptToAgentTab({
      tabId,
      agent: launched,
      content,
      submit,
      forcePaste: submit,
      onTimeout: () =>
        submit
          ? showAgentLaunchPromptNotDeliveredNotice({ agent: launched, prompt: content })
          : notifyDirectWorkItemAgentStartTimeout(launched, submit)
    })
  }
}
