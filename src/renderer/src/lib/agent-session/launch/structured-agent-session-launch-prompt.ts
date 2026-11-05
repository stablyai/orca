import type { StructuredAgentLaunchReceipt as LaunchReceipt } from './structured-agent-session-launch-recovery'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { agentSessionThrownFailure } from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  unstageStructuredLaunchPrompt,
  handBackStagedLaunchPrompt,
  type StagedStructuredLaunchPrompt,
  type StagedDelivery,
  type StructuredLaunchPromptOptions,
  type StructuredPromptDeliveryResult
} from './structured-agent-session-staged-prompt'
export {
  stageStructuredLaunchPrompt,
  discardStructuredLaunchPrompts,
  discardStructuredAgentSessionChatSends,
  takeBackLegacyStructuredLaunchPrompts,
  prepareLegacyStructuredLaunchPrompts,
  prepareStructuredLaunchPromptForCreate,
  issueStructuredLaunchPromptForCreate,
  hasStagedStructuredLaunchPrompt,
  type StagedStructuredLaunchPrompt,
  type StructuredLaunchPromptOptions,
  type StructuredPromptDeliveryResult
} from './structured-agent-session-staged-prompt'

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
        if (prompt.slot && !prompt.slot.prepare(input)) {
          unstageStructuredLaunchPrompt(prompt)
          const outcome = await prompt.slot.outcome
          return {
            delivered: false,
            inComposer: !prompt.callerKeepsText && outcome === 'returned',
            ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
          }
        }
      } catch (error) {
        if (prompt.discarded) {
          return { delivered: false, inComposer: false }
        }
        if (prompt.slot && !prompt.slot.active()) {
          unstageStructuredLaunchPrompt(prompt)
          const outcome = await prompt.slot.outcome
          return {
            delivered: false,
            inComposer: !prompt.callerKeepsText && outcome === 'returned',
            ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
          }
        }
        unstageStructuredLaunchPrompt(prompt)
        const inComposer = handBackStagedLaunchPrompt(prompt)
        publishStructuredAgentSessionSends(prompt.sessionId, {
          notice: error instanceof Error ? error.message : String(error)
        })
        return { delivered: false, inComposer, failureNotified: true }
      }
    }
    const sent = prompt.slot
      ? prompt.slot.send(target)
      : sendStructuredAgentSessionMessage({
          sessionId: prompt.sessionId,
          target,
          text: prompt.text,
          attachments: prompt.attachments,
          skills: prompt.skills
        })
    if (!sent) {
      // Another send of the chat holds its slot: the launch text waits in the composer instead.
      unstageStructuredLaunchPrompt(prompt)
      return { delivered: false, inComposer: handBackStagedLaunchPrompt(prompt), busy: true }
    }
    try {
      const outcome = await sent.outcome
      return {
        delivered: outcome === 'recorded',
        inComposer: !prompt.callerKeepsText && outcome === 'returned',
        ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
      }
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
        const result = {
          delivered: false,
          inComposer: handBackStagedLaunchPrompt(prompt),
          failureNotified: true
        }
        prompt.delivery = Promise.resolve(result)
        prompt.settleCreate(result)
        unstageStructuredLaunchPrompt(prompt)
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
        unstageStructuredLaunchPrompt(prompt)
        prompt.discarded = true
        const inComposer = handBackStagedLaunchPrompt(prompt)
        return {
          delivered: false,
          failureNotified: true,
          ...(inComposer ? { inComposer: true as const } : {})
        }
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
