import { agentDeliversDraftViaNativePrefill } from '@/lib/agent-native-draft-prefill'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import {
  isPromptReceiptEligible,
  watchForPromptSubmitReceipt
} from '@/lib/agent-prompt-submit-receipt'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/types'

/** Why a reason: launch failures diverge — 'readiness-timeout' means the TUI
 * never looked ready (nothing was sent), 'receipt-timeout' means the paste
 * and Enter went in but the agent never acknowledged a submitted prompt
 * (trust/update/login screen swallowed it — issue #7466). */
export type LaunchPromptDeliveryFailureReason = 'readiness-timeout' | 'receipt-timeout'

export async function deliverLaunchPromptToAgentTab(args: {
  tabId: string
  agent: TuiAgent
  content: string
  submit: boolean
  forcePaste: boolean
  /** Why: receipt eligibility reads LOCAL evidence (local hook install state,
   * locally-observed statuses), which says nothing about a remote host whose
   * hooks may silently not fire — strict-gating there would false-fail
   * delivered prompts. Remote launches keep the optimistic verdict until
   * host-scoped evidence exists (follow-up). */
  remoteLaunch?: boolean
  timeoutMs?: number
  onTimeout?: (reason?: LaunchPromptDeliveryFailureReason) => void
}): Promise<boolean> {
  const { tabId, agent, content, submit, forcePaste, remoteLaunch, timeoutMs, onTimeout } = args
  const shouldSeed =
    submit === true && content.trim().length > 0 && isNativeChatSupportedAgent(agent)

  if (shouldSeed) {
    useAppStore.getState().seedNativeChatLaunchPrompt({
      tabId,
      agent,
      text: content,
      createdAt: Date.now()
    })
  }

  // Why: native-prefill agents (claude/openclaude etc.) get the prompt at launch,
  // so pasteDraftWhenAgentReady returns false without pasting. That is a successful
  // native delivery, not a failure — don't flag the seeded bubble in that case.
  const deliversViaNativePrefill = agentDeliversDraftViaNativePrefill(agent, forcePaste)

  // Why: readiness heuristics can pass on screens that swallow the paste
  // (codex trust/update, claude login), so submitted launch prompts are only
  // "delivered" once the agent's own managed hook acknowledges a submitted
  // prompt (UserPromptSubmit). Agents without installed managed hooks keep
  // the optimistic legacy verdict instead of false-failing. Native-prefill
  // delivery has no submitted paste, so it never waits on a receipt (which
  // would never arrive).
  const requireReceipt =
    submit === true &&
    remoteLaunch !== true &&
    !deliversViaNativePrefill &&
    (await isPromptReceiptEligible(agent))
  const receiptWatch = requireReceipt
    ? watchForPromptSubmitReceipt({ tabId, agent, since: Date.now() })
    : null

  const markSeedFailed = (): void => {
    if (shouldSeed) {
      useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
    }
  }

  let pasted: boolean
  try {
    pasted = await pasteDraftWhenAgentReady({
      tabId,
      content,
      agent,
      submit,
      forcePaste,
      timeoutMs,
      onTimeout: onTimeout ? () => onTimeout('readiness-timeout') : undefined
    })
  } catch (error) {
    // Why: the receipt timeout is only armed after a successful paste, so an
    // unexpected paste throw must still release the watch's IPC subscription.
    receiptWatch?.cancel()
    throw error
  }

  if (!pasted && !deliversViaNativePrefill) {
    receiptWatch?.cancel()
    markSeedFailed()
    return false
  }

  if (receiptWatch) {
    // Why: arm the receipt window only now that the paste+Enter is in, so the
    // full timeout covers the post-submit hook round-trip rather than the
    // preceding readiness wait (which can run many seconds on a cold SSH boot).
    receiptWatch.startTimer()
    const receipted = await receiptWatch.result
    if (!receipted) {
      onTimeout?.('receipt-timeout')
      markSeedFailed()
      return false
    }
  }

  return true
}
