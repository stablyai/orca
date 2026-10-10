import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
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
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  /** Not sent, and waiting in the new chat's composer, which now owns the text. */
  inComposer?: true
  /** Nobody could confirm it went: the host may hold it. */
  unconfirmed?: true
  /** Another send of the chat held its one slot, so this one never went. */
  busy?: true
}

type StagedDelivery = Omit<StructuredPromptDeliveryResult, 'inComposer' | 'failureNotified'> & {
  inComposer: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number; firstMessage?: AgentJournalSubmission }

/** A launch's text, held in memory from the click until its chat exists, then sent once: every
 *  caller waiting on it shares the one send. From the click it holds the chat's one send slot, drawn
 *  as sending, so nothing typed meanwhile goes out ahead of it. */
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

/** The launch was cancelled: what it staged is dropped with its chat. */
export function discardStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    prompt.slot?.release()
    prompt.discarded = true
    prompt.discard()
  }
  staged.delete(sessionId)
}

/** The chat is closing or its launch was cancelled: nothing it was sending goes out any more. */
export function discardStructuredAgentSessionChatSends(sessionId: string): void {
  discardStructuredLaunchPrompts(sessionId)
  dropStructuredAgentSessionSends(sessionId)
}

/** A Stop before the chat is published: text its launch has not sent goes back to the composer,
 *  never sent. The start itself goes on. */
export function takeBackLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.delivery || prompt.createOwned) {
      continue
    }
    unstage(prompt)
    prompt.discarded = true
    handBackStagedPrompt(prompt)
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

/** Whether a launch still holds text for this chat that has not reached its host. */
export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (staged.get(sessionId)?.size ?? 0) > 0
}

/** Puts a launch's text in its chat's composer, unless its sender keeps it. True when it did; a
 *  draft write that throws is reported in the chat instead, and never stops its caller. */
function handBackStagedPrompt(prompt: StagedStructuredLaunchPrompt): boolean {
  if (prompt.callerKeepsText) {
    return false
  }
  try {
    handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, [])
    )
    return true
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
  // Why: a draft has no delivery event — the composer adopts it and the user sends it — so
  // `onPromptDelivered` never fires and no result is reported.
  if (args.options.promptDelivery === 'draft' || !args.options.prompt?.trim()) {
    return undefined
  }
  const prompt = args.stagedPrompt
  const settled = args.launchResult.then(
    async (receipt) => {
      if (!prompt || prompt.discarded) {
        return { delivered: false, failureNotified: true }
      }
      if (prompt.createOwned) {
        prompt.createSend?.settle(
          receipt.firstMessage
            ? { kind: 'recorded', submission: receipt.firstMessage }
            : { kind: 'unconfirmed' }
        )
      }
      const { delivered, inComposer, unconfirmed, busy } = await sendStagedPrompt(
        prompt,
        receipt,
        args.target
      )
      return {
        delivered,
        failureNotified: false,
        ...(inComposer ? { inComposer: true as const } : {}),
        ...(unconfirmed ? { unconfirmed } : {}),
        ...(busy ? { busy } : {})
      }
    },
    (error: unknown) => {
      if (prompt?.createOwned) {
        prompt.createSend?.settle(
          error instanceof StructuredAgentSessionCreateRefusalError
            ? { kind: 'refused', failure: agentSessionThrownFailure(error, error.code) }
            : { kind: 'unconfirmed' }
        )
      }
      // The chat never started: its text waits in the chat's composer for the person's own Send.
      if (prompt && !prompt.discarded && !prompt.delivery) {
        unstage(prompt)
        prompt.discarded = true
        handBackStagedPrompt(prompt)
      }
      throw error
    }
  )
  const result = prompt
    ? Promise.race([
        settled,
        prompt.whenCreateSettled.then(({ inComposer, ...outcome }) => ({
          ...outcome,
          failureNotified: false,
          ...(inComposer ? { inComposer: true as const } : {})
        })),
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
    return outcome
  })
}
