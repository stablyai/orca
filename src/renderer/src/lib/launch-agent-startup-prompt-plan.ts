import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  planLaunchPrompt,
  type AgentStartupPlan,
  type AgentStartupPlanInputs
} from '@/lib/tui-agent-startup'
import type { LaunchFile, UnstageableLine } from '../../../shared/launch-prompt-file'
import type { LaunchHost } from '../../../shared/launch-host'

export type LaunchAgentStartupPromptPlan = {
  startupPlan: AgentStartupPlan | null
  /** Written by the host before it types the launch line naming it. */
  launchFile?: LaunchFile
  /** The rule's wish for a line the host cannot stage, sent with the spawn. */
  unstageableLine?: UnstageableLine
  /** Text to paste once the TUI is ready; null when the launch command already carries it. */
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
}

/**
 * Decide how a new-tab launch delivers its prompt: on the agent's launch command or in a launch file
 * where `carryLaunchPrompt` says it can ride, else pasted once the agent is ready.
 */
export function planLaunchAgentStartupPrompt(args: {
  base: AgentStartupPlanInputs
  /** Already trimmed. */
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  isFollowupPath: boolean
  /** The host the launch runs on (`clientLaunchHost`). */
  host: LaunchHost
}): LaunchAgentStartupPromptPlan {
  const { base, prompt, promptDelivery, isFollowupPath } = args
  const pasteAfterReady = (
    startupPlan: AgentStartupPlan | null,
    text: string,
    submit: boolean
  ): LaunchAgentStartupPromptPlan => ({
    startupPlan,
    pasteDraftAfterLaunch: text,
    submitPastedPrompt: submit
  })
  const cleanPlan = (): AgentStartupPlan | null =>
    buildAgentStartupPlan({ ...base, allowEmptyPromptLaunch: true })

  if (prompt.length > 0 && promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({ ...base, draft: prompt })
    if (!draftLaunchPlan) {
      return pasteAfterReady(cleanPlan(), prompt, false)
    }
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
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    }
  }
  // Why outside the rule: this is the caller's need, not a host fact. A caller that waits for
  // delivery gets a verdict from a paste, and this client cannot observe a paired host's carried
  // prompt reach its agent. Temporary, until paired hosts report that receipt.
  if (prompt.length > 0 && args.host.paired && promptDelivery === 'submit-after-ready') {
    return pasteAfterReady(cleanPlan(), prompt, true)
  }
  const planned = planLaunchPrompt({
    ...base,
    prompt,
    host: args.host,
    // Why: main pastes a submit-after-ready prompt once the agent runs and types the rest.
    paste: promptDelivery === 'submit-after-ready' ? 'once-agent-runs' : 'when-host-proves-agent'
  })
  if (!planned) {
    return { startupPlan: null, pasteDraftAfterLaunch: null, submitPastedPrompt: false }
  }
  switch (planned.carry) {
    case 'none':
      return { startupPlan: planned.plan, pasteDraftAfterLaunch: null, submitPastedPrompt: false }
    case 'on-line':
      return {
        startupPlan: planned.plan,
        ...(planned.unstageableLine ? { unstageableLine: planned.unstageableLine } : {}),
        pasteDraftAfterLaunch: null,
        submitPastedPrompt: false
      }
    case 'launch-file':
      return {
        startupPlan: planned.plan,
        launchFile: planned.launchFile,
        pasteDraftAfterLaunch: null,
        submitPastedPrompt: false
      }
    case 'paste-after-ready':
      // An agent that takes text only after start keeps an auto-submit prompt as an editable draft.
      return pasteAfterReady(
        planned.cleanPlan,
        planned.text,
        !isFollowupPath || promptDelivery === 'submit-after-ready'
      )
  }
}
