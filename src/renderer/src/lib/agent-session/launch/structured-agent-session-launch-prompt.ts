import type { StructuredAgentLaunchReceipt as LaunchReceipt } from './structured-agent-session-launch-recovery'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { agentSessionWriteFailureText } from '@/components/native-chat/messages/notices/agent-session-write-notice-text'
import { agentSessionThrownFailure } from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-attempt'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  finishStagedLaunchPromptWithHandBack,
  stagedDeliveryFromSlotOutcome,
  stagedSendDelivery,
  unstageStructuredLaunchPrompt,
  type StagedStructuredLaunchPrompt,
  type StagedDelivery,
  type StructuredLaunchPromptOptions
} from './structured-agent-session-staged-prompt'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-callers'

function promptDeliveryResult(outcome: StagedDelivery): StructuredPromptDeliveryResult {
  return {
    ...outcome,
    inComposer: outcome.inComposer ? true : undefined,
    failureNotified: outcome.failureNotified ?? false
  }
}

function sendStagedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget
): Promise<StagedDelivery> {
  prompt.delivery ??= (async () => {
    noteStructuredAgentSessionFence(prompt.sessionId, receipt.fence)
    if (prompt.prepare) {
      try {
        const input = await prompt.prepare(prompt.sessionId, target)
        if (prompt.discarded) {
          return { delivered: false, inComposer: false }
        }
        prompt.text = input.text
        prompt.attachments = input.attachments
        prompt.skills = input.skills
        prompt.custodyLost = input.custodyLost
        if (prompt.slot && !prompt.slot.prepare(input, input.custodyLost)) {
          // The reservation already ended: its own outcome is the result.
          unstageStructuredLaunchPrompt(prompt)
          return stagedDeliveryFromSlotOutcome(prompt, await prompt.slot.outcome)
        }
      } catch (error) {
        if (prompt.discarded) {
          return { delivered: false, inComposer: false }
        }
        if (prompt.slot && !prompt.slot.active()) {
          unstageStructuredLaunchPrompt(prompt)
          return stagedDeliveryFromSlotOutcome(prompt, await prompt.slot.outcome)
        }
        // Preparation failed with the reservation still held (also after a paired create succeeded):
        // the terminal hand-back is published before the reservation is released. It words why, and a
        // hand-back that threw adds that the message wasn't saved instead of being worded over.
        const notice = error instanceof Error ? error.message : String(error)
        if (!notice) {
          // Empty when another notice already says why (a file held in another chat's draft).
          publishStructuredAgentSessionSends(prompt.sessionId, { notice: null })
        }
        return await finishStagedLaunchPromptWithHandBack(prompt, {
          failureNotified: true,
          ...(notice ? { notice } : {})
        })
      }
    }
    // Either path reports what its own send heard: a direct send (no reservation at staging, joined
    // after the slot freed) keeps the caller's copy exactly as a reserved one does.
    const sent = prompt.slot
      ? prompt.slot.send(target)
      : sendStructuredAgentSessionMessage({
          sessionId: prompt.sessionId,
          target,
          text: prompt.text,
          attachments: prompt.attachments,
          skills: prompt.skills,
          ...(prompt.callerKeepsText ? { callerKeepsText: true as const } : {}),
          ...(prompt.custodyLost ? { custodyLost: prompt.custodyLost } : {})
        })
    if (!sent) {
      // Another send of the chat holds its slot: the launch text waits in the composer instead.
      return finishStagedLaunchPromptWithHandBack(prompt, { busy: true })
    }
    try {
      const outcome = await sent.outcome
      return stagedSendDelivery(prompt, outcome, sent.handedBack(), sent.recorded)
    } finally {
      unstageStructuredLaunchPrompt(prompt)
    }
  })()
  return prompt.delivery
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  target: RuntimeClientTarget
  options: StructuredLaunchPromptOptions
  stagedPrompt: StagedStructuredLaunchPrompt | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  // Drafts transfer ownership to composer/user, not delivery; emit neither onPromptDelivered nor a result.
  if (
    args.options.promptDelivery === 'draft' ||
    (!args.options.prompt?.trim() && !args.options.promptAttachments?.length)
  ) {
    return undefined
  }
  const prompt = args.stagedPrompt
  const settled = args.launchResult.then(
    async (receipt) => {
      if (!prompt || prompt.discarded) {
        return { delivered: false, failureNotified: true }
      }
      if (receipt.configurationFailure) {
        const result = await finishStagedLaunchPromptWithHandBack(prompt, {
          failureNotified: true,
          notice: agentSessionWriteFailureText(receipt.configurationFailure, 'option')
        })
        prompt.discarded = true
        return promptDeliveryResult(result)
      }
      if (prompt.createOwned) {
        prompt.createSend?.settle(
          receipt.firstMessage
            ? { kind: 'recorded', submission: receipt.firstMessage, cursor: receipt.cursor }
            : { kind: 'unconfirmed' }
        )
      }
      return promptDeliveryResult(await sendStagedPrompt(prompt, receipt, args.target))
    },
    (error: unknown) => {
      if (prompt?.createOwned) {
        prompt.createSend?.settle(
          error instanceof StructuredAgentSessionCreateRefusalError
            ? { kind: 'refused', failure: agentSessionThrownFailure(error, error.code) }
            : { kind: 'unconfirmed' }
        )
        return prompt.whenCreateSettled.then(({ inComposer, ...outcome }) => ({
          ...outcome,
          failureNotified: error instanceof StructuredAgentSessionCreateRefusalError,
          ...(inComposer ? { inComposer: true as const } : {})
        }))
      }
      // The launch did not submit: its text waits in the chat's composer for the person's own Send.
      if (prompt && !prompt.discarded && !prompt.delivery) {
        prompt.discarded = true
        // The hand-back's durability is separate from its end: either way nothing later takes custody.
        return Promise.resolve(
          finishStagedLaunchPromptWithHandBack(prompt, { failureNotified: true })
        ).then(promptDeliveryResult)
      }
      // The reserved sender may already have returned/retained the input during create rejection.
      return prompt?.delivery
        ? prompt.delivery.then((outcome) =>
            promptDeliveryResult({ ...outcome, failureNotified: true })
          )
        : { delivered: false, failureNotified: true }
    }
  )
  const result = prompt
    ? Promise.race([
        settled,
        prompt.whenCreateSettled.then(promptDeliveryResult),
        prompt.whenDiscarded.then((): StructuredPromptDeliveryResult => ({
          delivered: false,
          failureNotified: true
        }))
      ])
    : settled
  return result.then((outcome) => {
    if (outcome.delivered) {
      args.options.onPromptDelivered?.()
    }
    return prompt?.recipientDiscarded
      ? { ...outcome, recipientOwned: true as const, failureNotified: true }
      : outcome
  })
}
