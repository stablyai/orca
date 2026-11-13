import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { planLaunchAgentStartupPrompt } from '../prompt/launch-agent-startup-prompt-plan'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { yieldAgentChoicesToArgs } from '../../../../../../shared/agent-launch/choices/agent-choice-layers'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import {
  launchAgentThroughHost,
  type HostAgentLaunchArgs
} from '@/lib/agent-session/launch/pane/agent-launch-through-host'
import { pasteAgentLaunchPromptOnceReady } from '@/lib/agent-session/launch/prompt/launch-agent-tab-prompt-paste'

/** Local terminal actions start in their own pane; structured routes resolve earlier and SSH keeps its remote launch path. */
export function newTabPromptLaunchesThroughHost(args: {
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastesPrompt: boolean
  isRemote: boolean
}): boolean {
  return args.promptDelivery === 'submit-after-ready' && args.pastesPrompt && !args.isRemote
}

/** Observe readiness as soon as the tab PTY exists, but paste only after its pane confirms agent startup; a fast agent may be ready before spawn returns. */
export function launchNewTabPromptThroughHost(
  args: HostAgentLaunchArgs & {
    /** What is pasted, which can differ from the prompt the user wrote. */
    pasteContent: string
    submit: boolean
    onPromptDelivered?: () => void
    onPromptDeliveryUnconfirmed?: () => void
  }
): {
  tabId: string
  promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }>
} {
  const { pasteContent, submit, onPromptDelivered, onPromptDeliveryUnconfirmed, ...launch } = args
  const { tabId, started } = launchAgentThroughHost({
    ...launch,
    suppressStartupUpdatePrompt: submit
  })
  const pasted = pasteAgentLaunchPromptOnceReady({
    worktreeId: args.worktreeId,
    tabId,
    agent: args.agent,
    content: pasteContent,
    submit,
    prompt: args.prompt,
    launchPty: started,
    ...(onPromptDelivered ? { onPromptDelivered } : {}),
    ...(onPromptDeliveryUnconfirmed ? { onPromptDeliveryUnconfirmed } : {})
  })
  // The pane already says why it didn't start, and a closed tab needs nothing: no second notice.
  const promptDeliveryResult = started.then((launched) =>
    launched ? pasted : { delivered: false, failureNotified: true }
  )
  return { tabId, promptDeliveryResult }
}

/** The same pane owner plans edited empty-prompt and inline-prompt launches from current settings. */
export function launchNewTabThroughHost(
  args: HostAgentLaunchArgs & { onPromptDelivered?: () => void }
) {
  const { onPromptDelivered, ...launch } = args
  const { tabId, started } = launchAgentThroughHost({
    ...launch,
    ...(args.prompt ? { promptOnLaunch: true as const } : {})
  })
  return {
    tabId,
    ...(args.prompt
      ? {
          promptDeliveryResult: started.then((started) => {
            if (started) {
              onPromptDelivered?.()
            }
            return { delivered: Boolean(started), failureNotified: !started }
          })
        }
      : {})
  }
}

export function newTabHostSessionOptions(args: LaunchAgentInNewTabArgs, shell: AgentStartupShell) {
  const raw = tokenizeStartupCommand(args.agentArgs ?? '', shell)
  return args.sessionOptionsYieldToAgentArgs && raw.ok && args.sessionOptions
    ? yieldAgentChoicesToArgs(args.agent, args.sessionOptions, raw.tokens)
    : args.sessionOptions
}

export function buildNewTabStartup(
  args: LaunchAgentInNewTabArgs,
  settings: AgentStartupSettings | null,
  context: {
    resolvedLaunchPlatform: NodeJS.Platform
    queuedShell?: AgentStartupShell
    isRemote: boolean
  },
  agentLaunchChoices: AgentStartupSettings['agentLaunchChoices']
) {
  return planLaunchAgentStartupPrompt({
    base: resolveAgentStartupPlanInputs({
      agent: args.agent,
      settings: { ...settings, agentLaunchChoices },
      agentArgs: args.agentArgs,
      sessionOptions: args.sessionOptions,
      terminalOptionEdits: args.terminalOptionEdits,
      sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
      platform: context.resolvedLaunchPlatform,
      shell: context.queuedShell,
      isRemote: context.isRemote
    }),
    prompt: args.prompt?.trim() ?? '',
    promptDelivery: args.promptDelivery ?? 'auto-submit',
    isFollowupPath: TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'stdin-after-start'
  })
}
