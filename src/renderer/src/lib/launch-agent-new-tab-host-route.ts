import {
  launchAgentThroughHost,
  windowMakesHostLaunchTab,
  type HostAgentLaunchArgs
} from '@/lib/agent-launch-through-host'
import { pasteAgentLaunchPromptOnceReady } from '@/lib/launch-agent-tab-prompt-paste'

/** AI-button terminal launches start via their own pane spawn while this window pastes. Typed prompts, chat-capable routes and SSH retain main’s launch path; local pane spawn cannot start those SSH sessions. */
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
