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
