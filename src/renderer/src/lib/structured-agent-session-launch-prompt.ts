import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentLaunchReceipt } from './agent-session/launch/structured-agent-session-launch-recovery'
import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { agentSessionThrownFailure } from '../../../shared/agent-session-write-failure'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  sendStructuredAgentSessionMessage,
  type StructuredAgentSessionCreateSend,
  type StructuredAgentSessionReservedSend
} from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  /** Not sent, and waiting in the new chat's composer, which now owns the text. */
  inComposer?: true
  /** An admitted recipient took ownership before it was explicitly discarded. */
  recipientOwned?: true
  /** Nobody could confirm it went: the host may hold it. */
  unconfirmed?: true
  /** Another send of the chat held its one slot, so this one never went. */
  busy?: true
}

type StagedDelivery = Omit<StructuredPromptDeliveryResult, 'inComposer' | 'failureNotified'> & {
  inComposer: boolean
  failureNotified?: boolean
}

function promptDeliveryResult(outcome: StagedDelivery): StructuredPromptDeliveryResult {
  return {
    ...outcome,
    inComposer: outcome.inComposer ? true : undefined,
    failureNotified: outcome.failureNotified ?? false
  }
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

type LaunchReceipt = StructuredAgentLaunchReceipt

/** Share one staged-text send across launch callers; reserve the chat send slot at click so typed messages cannot overtake it before create. */
export type StagedStructuredLaunchPrompt = {
  sessionId: string
  text: string
  slot: StructuredAgentSessionReservedSend | null
  /** Its sender keeps the text if it comes back (notes), instead of the chat's composer. */
  callerKeepsText?: true
  delivery?: Promise<StagedDelivery>
  /** Create owns this prompt; it must never become a later send. */
  createOwned?: true
  createSend?: StructuredAgentSessionCreateSend
  whenCreateSettled: Promise<StagedDelivery>
  settleCreate: (outcome: StagedDelivery) => void
  /** Its launch was cancelled: never sent, never given back. */
  discarded?: true
  recipientDiscarded?: true
  /** Settles once it is discarded, so its callers need not wait on a create that may never end. */
  whenDiscarded: Promise<void>
  discard: () => void
}

const staged = new Map<string, Set<StagedStructuredLaunchPrompt>>()

export function stageStructuredLaunchPrompt(
  sessionId: string,
  text: string,
  options: { callerKeepsText?: true } = {}
): StagedStructuredLaunchPrompt {
  let discard = (): void => {}
  const whenDiscarded = new Promise<void>((resolve) => {
    discard = resolve
  })
  let settleCreate = (_outcome: StagedDelivery): void => {}
  const whenCreateSettled = new Promise<StagedDelivery>((resolve) => {
    settleCreate = resolve
  })
  const prompt: StagedStructuredLaunchPrompt = {
    sessionId,
    text,
    slot: reserveStructuredAgentSessionSend({ sessionId, text, ...options }),
    ...options,
    whenDiscarded,
    discard,
    whenCreateSettled,
    settleCreate
  }
  const forSession = staged.get(sessionId) ?? new Set()
  forSession.add(prompt)
  staged.set(sessionId, forSession)
  void prompt.slot?.outcome.then((outcome) => {
    const result: StagedDelivery = {
      delivered: outcome === 'recorded',
      inComposer: !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
      ...(outcome === 'unconfirmed' ? { unconfirmed: true } : {})
    }
    if (!prompt.delivery) {
      prompt.delivery = Promise.resolve(result)
      unstage(prompt)
    }
    prompt.settleCreate(result)
  })
  return prompt
}

function unstage(prompt: StagedStructuredLaunchPrompt): void {
  prompt.slot?.release()
  const forSession = staged.get(prompt.sessionId)
  forSession?.delete(prompt)
  if (forSession?.size === 0) {
    staged.delete(prompt.sessionId)
  }
}

export function discardStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    prompt.slot?.release()
    prompt.discarded = true
    if (prompt.slot && !prompt.callerKeepsText) {
      prompt.recipientDiscarded = true
    }
    prompt.discard()
  }
  staged.delete(sessionId)
}

/** The chat is closing or its launch was cancelled: nothing it was sending goes out any more. */
export function discardStructuredAgentSessionChatSends(sessionId: string): void {
  discardStructuredLaunchPrompts(sessionId)
  dropStructuredAgentSessionSends(sessionId)
}

// Prepublication Stop returns unsent text to the composer while allowing chat startup to continue.
export function takeBackLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.delivery || prompt.createOwned) {
      continue
    }
    unstage(prompt)
    prompt.discarded = true
    const inComposer = handBackStagedPrompt(prompt)
    prompt.settleCreate({ delivered: false, inComposer, failureNotified: true })
    prompt.discard()
  }
}

export function prepareLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    prompt.slot?.legacy()
  }
}

/** Transfers the first staged prompt to create, retaining the sender's deadline and bubble. */
export function prepareStructuredLaunchPromptForCreate(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionFirstMessage | undefined {
  const prompt = [...(staged.get(sessionId) ?? [])].find(
    (candidate) => !candidate.discarded && !candidate.delivery
  )
  if (!prompt) {
    return undefined
  }
  prompt.createOwned = true
  const sent = prompt.slot?.create(target)
  prompt.createSend = sent ?? undefined
  prompt.delivery = sent
    ? sent.outcome.then((outcome) => {
        unstage(prompt)
        return {
          delivered: outcome === 'recorded',
          inComposer:
            !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
          ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
        }
      })
    : Promise.resolve({ delivered: false, inComposer: !prompt.callerKeepsText }).then((outcome) => {
        unstage(prompt)
        return outcome
      })
  void prompt.delivery.then(prompt.settleCreate)
  return sent?.message
}

export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (staged.get(sessionId)?.size ?? 0) > 0
}

/** Return launch text to the composer unless the sender retains it. Report draft-write failure in chat without blocking the caller; true means adopted. */
function handBackStagedPrompt(prompt: StagedStructuredLaunchPrompt): boolean {
  if (prompt.callerKeepsText) {
    return false
  }
  try {
    return handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, [])
    )
  } catch (error) {
    console.error(
      '[native-chat-send] a launch message could not be put back in the composer',
      error
    )
    publishStructuredAgentSessionSends(prompt.sessionId, {
      notice: agentSessionWriteNoticeText(['messageNotSaved'])
    })
    return false
  }
}

function sendStagedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget
): Promise<StagedDelivery> {
  prompt.delivery ??= (async () => {
    noteStructuredAgentSessionFence(prompt.sessionId, receipt.fence)
    const sent =
      prompt.slot?.send(target) ??
      sendStructuredAgentSessionMessage({ sessionId: prompt.sessionId, target, text: prompt.text })
    if (!sent) {
      // Another send of the chat holds its slot: the launch text waits in the composer instead.
      unstage(prompt)
      return { delivered: false, inComposer: handBackStagedPrompt(prompt), busy: true }
    }
    try {
      const outcome = await sent.outcome
      return {
        delivered: outcome === 'recorded',
        inComposer:
          !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
        ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
      }
    } finally {
      unstage(prompt)
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
  if (args.options.promptDelivery === 'draft' || !args.options.prompt?.trim()) {
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
          inComposer: handBackStagedPrompt(prompt),
          failureNotified: true
        }
        prompt.delivery = Promise.resolve(result)
        prompt.settleCreate(result)
        unstage(prompt)
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
      }
      // The launch did not submit: its text waits in the chat's composer for the person's own Send.
      if (prompt && !prompt.discarded && !prompt.delivery) {
        unstage(prompt)
        prompt.discarded = true
        const inComposer = handBackStagedPrompt(prompt)
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
