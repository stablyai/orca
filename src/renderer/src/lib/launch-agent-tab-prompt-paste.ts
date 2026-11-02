import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Share readiness/paste delivery and outcome reporting for both window-spawned and agent.launch-owned tab PTYs. */
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
  /** The launch pane's PTY once its agent started; the paste goes there and nowhere else. */
  launchPty?: Promise<string | null>
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
    ...(args.launchPty ? { launchPty: args.launchPty } : {}),
    ...(onPromptDeliveryUnconfirmed ? { onUnconfirmedDelivery: onPromptDeliveryUnconfirmed } : {})
  }).then((delivered) => {
    if (delivered) {
      if (agent === 'command-code' && submit) {
        // Command Code lacks prompt-submit hooks; seed working when generated input is submitted after readiness.
        seedCommandCodeSubmittedPromptStatus(worktreeId, tabId, args.prompt)
      }
      onPromptDelivered?.()
    }
    return { delivered, failureNotified: !delivered && timeoutNotice.wasNotified() }
  })
}
