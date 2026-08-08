import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'

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

/**
 * Decide how a new-tab launch delivers its prompt: argv/flag agents fold it
 * into the launch command, while followup and generated launches start clean
 * and paste after the TUI is ready.
 */
export function planLaunchAgentStartupPrompt(args: {
  base: StartupPlanBase
  /** Already trimmed. */
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  isFollowupPath: boolean
}): LaunchAgentStartupPromptPlan {
  const { base, prompt, promptDelivery, isFollowupPath } = args
  const hasPrompt = prompt.length > 0
  const launchEmpty = (): AgentStartupPlan | null =>
    buildAgentStartupPlan({ ...base, prompt: '', allowEmptyPromptLaunch: true })
  const pasteAfterReady = (submit: boolean): LaunchAgentStartupPromptPlan => ({
    startupPlan: launchEmpty(),
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
    return pasteAfterReady(false)
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
