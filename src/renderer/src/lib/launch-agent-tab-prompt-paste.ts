import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Pastes a new agent tab's prompt once its agent is ready, and says whether it landed. The one copy
 * of this delivery, for a tab whose terminal this window spawned and for one an `agent.launch`
 * spawned into it.
 */
export function pasteAgentLaunchPromptOnceReady(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  /** What is pasted, which can differ from the prompt the user wrote. */
  content: string
  submit: boolean
  /** The prompt as written, which Command Code's working row shows. */
  prompt: string
  onPromptDelivered?: () => void
  onPromptDeliveryUnconfirmed?: () => void
  /** Whether the paste may be written; readiness is observed while it is pending. */
  sendGate?: Promise<boolean>
}): Promise<{ delivered: boolean; failureNotified: boolean }> {
  const { worktreeId, tabId, agent, submit, onPromptDelivered, onPromptDeliveryUnconfirmed } = args
  const timeoutNotice = createPasteReadinessTimeoutNotice({
    worktreeId,
    tabId,
    agent,
    submitted: submit
  })
  return deliverLaunchPromptToAgentTab({
    tabId,
    content: args.content,
    agent,
    submit,
    forcePaste: true,
    onTimeout: timeoutNotice.onTimeout,
    ...(args.sendGate ? { sendGate: args.sendGate } : {}),
    ...(onPromptDeliveryUnconfirmed ? { onUnconfirmedDelivery: onPromptDeliveryUnconfirmed } : {})
  }).then((delivered) => {
    if (delivered) {
      if (agent === 'command-code' && submit) {
        // Why: Command Code has no prompt-submit hook; when Orca submits a
        // generated prompt after readiness, seed working at delivery time.
        seedCommandCodeSubmittedPromptStatus(worktreeId, tabId, args.prompt)
      }
      onPromptDelivered?.()
    }
    return { delivered, failureNotified: !delivered && timeoutNotice.wasNotified() }
  })
}
