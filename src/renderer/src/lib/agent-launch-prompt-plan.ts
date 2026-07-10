import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

/** Shared launch inputs for a single agent tab launch, minus the prompt fields
 *  this module resolves. */
export type AgentLaunchStartupPlanBase = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

export type AgentLaunchPromptPlan = {
  startupPlan: AgentStartupPlan | null
  /** Prompt text to bracket-paste into the TUI after launch, or null when the
   *  prompt (if any) rides the launch command itself. */
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
  forcePasteAfterLaunch: boolean
  trimmedPrompt: string
  hasPrompt: boolean
  isFollowupPath: boolean
}

/**
 * Resolve how a launch prompt reaches the agent: folded into the launch
 * command, left as an editable post-launch draft paste, or pasted+submitted
 * once the TUI is ready.
 *
 * Why: argv/flag agents fold the prompt into the launch command and
 * auto-submit — keeping behavior consistent with the composer/tab-bar `+`
 * mental model, where the prompt is "the first turn the user sent".
 * Followup-path and generated-context launches can deliver a prompt via
 * post-launch bracketed paste; callers decide whether that paste remains a
 * draft or submits after readiness.
 */
export function resolveAgentLaunchPromptPlan(args: {
  startupPlanBase: AgentLaunchStartupPlanBase
  prompt: string | undefined
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
}): AgentLaunchPromptPlan {
  const { startupPlanBase, prompt, promptDelivery } = args
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath =
    TUI_AGENT_CONFIG[startupPlanBase.agent].promptInjectionMode === 'stdin-after-start'

  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false
  let forcePasteAfterLaunch = false

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: generated multi-line prompts are too large to echo through a shell
    // argv/prefill command. Launch cleanly, then paste+submit inside the TUI.
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
    submitPastedPrompt = true
    forcePasteAfterLaunch = true
  } else if (hasPrompt && promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      ...startupPlanBase,
      draft: trimmedPrompt
    })
    if (draftLaunchPlan) {
      startupPlan = {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
    } else {
      startupPlan = buildAgentStartupPlan({
        ...startupPlanBase,
        prompt: '',
        allowEmptyPromptLaunch: true
      })
      pasteDraftAfterLaunch = trimmedPrompt
    }
  } else if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: hasPrompt ? trimmedPrompt : '',
      allowEmptyPromptLaunch: !hasPrompt
    })
  }

  return {
    startupPlan,
    pasteDraftAfterLaunch,
    submitPastedPrompt,
    forcePasteAfterLaunch,
    trimmedPrompt,
    hasPrompt,
    isFollowupPath
  }
}
