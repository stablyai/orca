import { resolveHostAgentStartupShell } from '../../../../../../shared/windows-terminal-shell'
import type { AgentStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '../../../../../../shared/agent-launch/startup/tui-agent-startup'

type StartupPlanBase = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

export type LaunchAgentStartupPromptPlan = {
  startupPlan: AgentStartupPlan | null
  /** Text to paste once the TUI is ready; null when the launch command already carries it. */
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
}

/** Choose argv/flag delivery versus clean launch plus post-ready paste for follow-up/generated prompts. */
export function planLaunchAgentStartupPrompt(args: {
  base: StartupPlanBase
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  isFollowupPath: boolean
  submitFollowup?: boolean
}): LaunchAgentStartupPromptPlan {
  const { base, prompt, promptDelivery, isFollowupPath } = args
  const hasPrompt = prompt.length > 0
  const pasteAfterReady = (
    submit: boolean,
    suppressUpdater = submit
  ): LaunchAgentStartupPromptPlan => ({
    startupPlan: buildAgentStartupPlan({
      ...base,
      prompt: '',
      allowEmptyPromptLaunch: true,
      // Why: Orca's own Enter must not answer a startup update prompt.
      suppressStartupUpdatePrompt: suppressUpdater
    }),
    pasteDraftAfterLaunch: prompt,
    submitPastedPrompt: submit
  })

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: multi-line generated prompts are too large for a shell argv, so launch clean then paste+submit in the TUI.
    return pasteAfterReady(true)
  }
  if (hasPrompt && promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({ ...base, draft: prompt })
    if (!draftLaunchPlan) {
      return pasteAfterReady(false)
    }
    return {
      startupPlan: {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.sessionOptions
          ? { sessionOptions: draftLaunchPlan.sessionOptions }
          : {}),
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    }
  }
  if (hasPrompt && isFollowupPath) {
    return pasteAfterReady(args.submitFollowup === true, false)
  }
  return {
    startupPlan: buildAgentStartupPlan({
      ...base,
      prompt: hasPrompt ? prompt : '',
      allowEmptyPromptLaunch: !hasPrompt
    }),
    pasteDraftAfterLaunch: null,
    submitPastedPrompt: false
  }
}

/** Normalize fresh hosted text without reading the desktop's launch settings. */
export function planHostedAgentPrompt(
  agent: TuiAgent,
  prompt: string,
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready',
  facts: { platform?: NodeJS.Platform; shell?: AgentStartupShell; submitFollowup?: boolean } = {}
) {
  if (
    prompt &&
    promptDelivery === 'draft' &&
    (!facts.platform || (facts.platform === 'win32' && !facts.shell))
  ) {
    return { startupPlan: null, pasteDraftAfterLaunch: prompt, submitPastedPrompt: false }
  }
  return planLaunchAgentStartupPrompt({
    base: {
      agent,
      cmdOverrides: {},
      agentArgs: null,
      platform: facts.platform ?? 'linux',
      shell: facts.shell,
      isRemote: true
    },
    prompt,
    promptDelivery,
    submitFollowup: facts.submitFollowup,
    isFollowupPath: TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  })
}

export function hostedAgentPromptDelivery(
  plan: LaunchAgentStartupPromptPlan,
  prompt: string,
  delivery: 'auto-submit' | 'draft' | 'submit-after-ready'
) {
  return plan.pasteDraftAfterLaunch !== null
    ? {
        promptAfterReady: plan.pasteDraftAfterLaunch,
        submitPrompt: plan.submitPastedPrompt,
        forcePromptPaste: true
      }
    : delivery === 'draft'
      ? { launchDraft: prompt }
      : {}
}

export function hostedAgentPromptRequest(
  plan: LaunchAgentStartupPromptPlan,
  prompt: string,
  delivery: 'auto-submit' | 'draft' | 'submit-after-ready'
) {
  return prompt && plan.pasteDraftAfterLaunch === null
    ? {
        prompt,
        promptDelivery: delivery === 'draft' ? ('draft' as const) : ('auto-submit' as const)
      }
    : plan.pasteDraftAfterLaunch !== null && plan.submitPastedPrompt
      ? { promptDelivery: 'auto-submit' as const }
      : {}
}

export function hostedAgentPromptHostFacts(
  platform: NodeJS.Platform | undefined,
  terminalWindowsShell: string | null | undefined
): { platform?: NodeJS.Platform; shell?: AgentStartupShell } {
  return {
    platform,
    shell:
      platform && (platform !== 'win32' || terminalWindowsShell)
        ? resolveHostAgentStartupShell({
            platform,
            isRemote: true,
            hostTerminalWindowsShell: terminalWindowsShell
          })
        : undefined
  }
}
