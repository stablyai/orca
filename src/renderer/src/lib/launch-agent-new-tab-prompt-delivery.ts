import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { waitForLaunchPromptReceipt } from '@/lib/agent-launch-prompt-receipt'
import {
  showAgentLaunchExitedNotice,
  showAgentLaunchPromptUnconfirmedNotice
} from '@/lib/agent-launch-prompt-not-delivered-notice'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab,
  seedNativeChatLaunchPromptForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import type { TuiAgent } from '../../../shared/tui-agent'

export type NewTabPromptDeliveryResult = Promise<{ delivered: boolean; failureNotified: boolean }>

/**
 * How a new agent tab's prompt is delivered, and when it counts as delivered: a paste once the agent
 * is ready, or for a prompt the launch carried, the agent's receipt of it. Never the tab existing.
 * Returns the result a `submit-after-ready` caller waits on; other callers fire and forget.
 */
export function deliverNewTabLaunchPrompt(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  /** Trimmed; empty for a launch with no prompt. */
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
  promptInLaunchFile: boolean
  launchedAt: number
  onPromptDelivered?: () => void
  onPromptDeliveryUnconfirmed?: () => void
}): NewTabPromptDeliveryResult | undefined {
  const { tabId, agent, prompt, promptDelivery, pasteDraftAfterLaunch } = args
  if (!prompt) {
    return undefined
  }
  const unconfirmed = args.onPromptDeliveryUnconfirmed
    ? { onUnconfirmedDelivery: args.onPromptDeliveryUnconfirmed }
    : {}
  // Why: no paste runs, so no paste seeds the chat's copy: a draft rode in on argv (Claude --prefill
  // etc.), and a submitted prompt rode the launch line. Not with a launch file: the transcript then
  // shows the pointer sentence, which would never prune this copy.
  if (pasteDraftAfterLaunch === null && !args.promptInLaunchFile) {
    if (promptDelivery === 'draft') {
      seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text: prompt })
    } else if (promptDelivery === 'submit-after-ready') {
      seedNativeChatLaunchPromptForAgentTab({ tabId, agent, text: prompt })
    }
  }
  if (pasteDraftAfterLaunch === null && promptDelivery === 'draft') {
    // A draft rode the launch command as an editable prefill; there is no turn to wait for.
    args.onPromptDelivered?.()
    return undefined
  }
  const content = pasteDraftAfterLaunch ?? prompt
  const submitted = pasteDraftAfterLaunch === null || args.submitPastedPrompt
  const timeoutNotice = createPasteReadinessTimeoutNotice({
    worktreeId: args.worktreeId,
    tabId,
    agent,
    submitted,
    content
  })
  // Why the receipt for a carried prompt: callers post replies and resolve threads on this result.
  const result =
    pasteDraftAfterLaunch === null
      ? waitForLaunchPromptReceipt({ tabId, agent, launchedAt: args.launchedAt }).then(
          (receipt) => {
            switch (receipt) {
              case 'delivered':
              case 'not-delivered':
                return timeoutNotice.settle(receipt === 'delivered', args.onPromptDelivered)
              case 'agent-exited':
                // Why its own words: the agent did not really start, so "paste it once ready" is wrong.
                showAgentLaunchExitedNotice({ agent, prompt })
                return { delivered: false, failureNotified: true }
              case 'unconfirmed':
                // Why silent when nothing waits on it: main reported nothing for such a launch, and
                // a host that cannot prove the agent (Windows without hooks) would raise it every time.
                if (promptDelivery !== 'submit-after-ready') {
                  return { delivered: false, failureNotified: false }
                }
                // The agent may have the prompt: say so, and never invite pasting it a second time.
                showAgentLaunchPromptUnconfirmedNotice({ agent, prompt })
                return { delivered: false, failureNotified: true }
            }
          }
        )
      : deliverLaunchPromptToAgentTab({
          tabId,
          content,
          agent,
          submit: submitted,
          forcePaste: true,
          onTimeout: timeoutNotice.onTimeout,
          ...unconfirmed
        }).then((delivered) => timeoutNotice.settle(delivered, args.onPromptDelivered))
  if (promptDelivery === 'submit-after-ready') {
    return result
  }
  void result.catch((error) => console.error('Prompt delivery failed after launch', error))
  return undefined
}
