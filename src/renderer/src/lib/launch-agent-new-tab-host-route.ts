import {
  launchAgentThroughHost,
  windowMakesHostLaunchTab,
  type HostAgentLaunchArgs
} from '@/lib/agent-launch-through-host'
import { pasteAgentLaunchPromptOnceReady } from '@/lib/launch-agent-tab-prompt-paste'

/**
 * Whether a new agent tab starts from the host's plan, in its own pane's spawn: an AI button's
 * launch, whose prompt is pasted once the agent is ready, in a terminal this window makes. Temporary:
 * the window keeps pasting the prompt as main does until the host delivers it. A typed prompt
 * (`auto-submit`, `draft`) keeps main's launch, and so does a launch the host could turn into a chat
 * or one in a workspace that runs over SSH, which the pane's local spawn cannot start.
 */
export function newTabPromptLaunchesThroughHost(args: {
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastesPrompt: boolean
  isRemote: boolean
}): boolean {
  return (
    args.promptDelivery === 'submit-after-ready' &&
    args.pastesPrompt &&
    !args.isRemote &&
    windowMakesHostLaunchTab()
  )
}

/**
 * Starts the agent in a new tab's own pane and pastes the prompt as main does. Readiness is watched
 * from the moment the tab's terminal exists, as main watches it, so an agent that is ready before
 * the spawn returns is not missed; the paste is written only once the pane's spawn says the agent
 * started there.
 */
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
  const { tabId, started } = launchAgentThroughHost(launch)
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
