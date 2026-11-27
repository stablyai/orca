import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'
import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  type StructuredAgentSessionCreateSend,
  type StructuredAgentSessionReservedSend
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/messages/notices/agent-session-write-notice-text'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredAgentSessionSendInput } from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-slot'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-callers'
import { abandonNativeChatPendingStagedLeases } from '@/components/native-chat/drafts/native-chat-draft-attachment-staging'
import type { StructuredAgentSessionSendOutcome } from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { nativeChatBrowserFileReferences } from '@/components/native-chat/attachments/native-chat-browser-file-references'

type LaunchMessage = Pick<StructuredAgentSessionSendInput, 'text' | 'attachments' | 'skills'>

export type StagedDelivery = Omit<
  StructuredPromptDeliveryResult,
  'inComposer' | 'failureNotified'
> & {
  inComposer: boolean
  failureNotified?: boolean
}

/**
 * An unconfirmed send can still be recorded later. Every launch result carries that send operation's
 * own recorded signal, whichever path (reservation, create, plain send) reports it first.
 */
export function unconfirmedStructuredLaunchDelivery(
  outcome: StructuredAgentSessionSendOutcome,
  recorded: Promise<void> | undefined
): Pick<StructuredPromptDeliveryResult, 'unconfirmed' | 'whenRecorded'> {
  if (outcome !== 'unconfirmed') {
    return {}
  }
  return { unconfirmed: true, ...(recorded ? { whenRecorded: recorded } : {}) }
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  promptAttachments?: StructuredAgentSessionSendInput['attachments']
  promptSkills?: StructuredAgentSessionSendInput['skills']
  preparePrompt?: (
    sessionId: string,
    target: RuntimeClientTarget
  ) => Promise<LaunchMessage & { custodyLost?: () => readonly string[] }>
}

/** Share one staged-text send across launch callers; reserve the chat send slot at click so typed messages cannot overtake it before create. */
export type StagedStructuredLaunchPrompt = {
  sessionId: string
  text: string
  attachments?: LaunchMessage['attachments']
  skills?: LaunchMessage['skills']
  prepare?: StructuredLaunchPromptOptions['preparePrompt']
  /** The prepared message's custody grant, checked at its issue. */
  custodyLost?: () => readonly string[]
  slot: StructuredAgentSessionReservedSend | null
  /** Its sender keeps the text if it comes back (notes), instead of the chat's composer. */
  callerKeepsText?: true
  delivery?: Promise<StagedDelivery>
  /** Create owns this prompt; it must never become a later send. */
  createOwned?: true
  createSend?: StructuredAgentSessionCreateSend
  whenCreateSettled: Promise<StagedDelivery>
  /** The first outcome wins; later calls are no-ops. */
  settleCreate: (outcome: StagedDelivery) => void
  /** That first outcome, once there is one: whoever settled the prompt owns its input. */
  settledResult: () => StagedDelivery | undefined
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
  options: {
    callerKeepsText?: true
    attachments?: LaunchMessage['attachments']
    skills?: LaunchMessage['skills']
    prepare?: StructuredLaunchPromptOptions['preparePrompt']
    delivery?: StructuredAgentSessionSendInput['delivery']
  } = {}
): StagedStructuredLaunchPrompt {
  let discard = (): void => {}
  const whenDiscarded = new Promise<void>((resolve) => {
    discard = resolve
  })
  let resolveCreate = (_outcome: StagedDelivery): void => {}
  const whenCreateSettled = new Promise<StagedDelivery>((resolve) => {
    resolveCreate = resolve
  })
  let settled: StagedDelivery | undefined
  const settleCreate = (outcome: StagedDelivery): void => {
    if (!settled) {
      settled = outcome
      resolveCreate(outcome)
    }
  }
  // The send's host delivery mode, not the prompt's own `delivery` promise.
  const { delivery: _sendDelivery, ...promptOptions } = options
  const prompt: StagedStructuredLaunchPrompt = {
    sessionId,
    text,
    slot: reserveStructuredAgentSessionSend({ sessionId, text, ...options }),
    ...promptOptions,
    whenDiscarded,
    discard,
    whenCreateSettled,
    settleCreate,
    settledResult: () => settled
  }
  const forSession = staged.get(sessionId) ?? new Set()
  forSession.add(prompt)
  staged.set(sessionId, forSession)
  void prompt.slot?.outcome.then((outcome) => {
    const result = stagedDeliveryFromSlotOutcome(prompt, outcome)
    if (!prompt.delivery) {
      prompt.delivery = Promise.resolve(result)
      unstageStructuredLaunchPrompt(prompt)
    }
    prompt.settleCreate(result)
  })
  return prompt
}

/** The public result of the prompt's reservation outcome: one mapping wherever either promise is read. */
export function stagedDeliveryFromSlotOutcome(
  prompt: StagedStructuredLaunchPrompt,
  outcome: StructuredAgentSessionSendOutcome
): StagedDelivery {
  return {
    delivered: outcome === 'recorded',
    inComposer: stagedPromptReturnedDurably(prompt, outcome),
    ...unconfirmedStructuredLaunchDelivery(outcome, prompt.slot?.recorded)
  }
}

/**
 * `inComposer` claims the recipient's draft durably holds the returned input, so a caller may retire
 * its own copy. A `returned` outcome only says the send ended: its hand-back may have thrown, or put
 * the input in a draft that isn't saved yet. Only a durable hand-back makes the claim.
 */
function stagedPromptReturnedDurably(
  prompt: StagedStructuredLaunchPrompt,
  outcome: StructuredAgentSessionSendOutcome
): boolean {
  return (
    !prompt.callerKeepsText && outcome === 'returned' && prompt.slot?.handedBack() === 'durable'
  )
}

/**
 * End a staged prompt by handing its message back without a send. The terminal result
 * (`handBackFinished`, plus `inComposer` for a durable write) is published to `prompt.delivery` and
 * `whenCreateSettled` synchronously, then the prompt is unstaged. Unstaging releases the reservation,
 * whose own generic "dropped" outcome arrives a microtask later and so can no longer win the public
 * race without the terminal signal.
 *
 * It acts only while it still owns the input: a prompt already settled (its reservation returned the
 * input, or another path won) keeps that result and gets no second hand-back, and a reservation that
 * already ended on its own contributes its actual outcome. Only a prompt whose input nothing has taken
 * (no reservation, or one still held) is handed back here.
 */
export function finishStagedLaunchPromptWithHandBack(
  prompt: StagedStructuredLaunchPrompt,
  extra: Partial<StagedDelivery> = {}
): StagedDelivery | Promise<StagedDelivery> {
  const settled = prompt.settledResult()
  if (settled) {
    unstageStructuredLaunchPrompt(prompt)
    return settled
  }
  const slot = prompt.slot
  if (slot && !slot.active()) {
    unstageStructuredLaunchPrompt(prompt)
    return slot.outcome.then((outcome) => stagedDeliveryFromSlotOutcome(prompt, outcome))
  }
  const result: StagedDelivery = {
    delivered: false,
    inComposer: handBackStagedLaunchPrompt(prompt),
    handBackFinished: true,
    ...extra
  }
  prompt.delivery ??= Promise.resolve(result)
  prompt.settleCreate(result)
  unstageStructuredLaunchPrompt(prompt)
  return result
}

export function unstageStructuredLaunchPrompt(prompt: StagedStructuredLaunchPrompt): void {
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
  // Nothing it was sending will be handed back now: a moved first send stops waiting for this draft.
  abandonNativeChatPendingStagedLeases(structuredAgentSessionDraftScopeKey(sessionId))
}

// Prepublication Stop returns unsent text to the composer while allowing chat startup to continue.
export function takeBackLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.delivery || prompt.createOwned) {
      continue
    }
    prompt.discarded = true
    // Settled before its reservation is released and before the discard is announced; a reservation
    // that already ended on its own reports its actual result first, then the discard.
    const finished = finishStagedLaunchPromptWithHandBack(prompt, { failureNotified: true })
    if (finished instanceof Promise) {
      void finished.then((result) => {
        prompt.settleCreate(result)
        prompt.discard()
      })
    } else {
      prompt.discard()
    }
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
  target: RuntimeClientTarget,
  takesSkills = false
): { firstMessage?: StructuredAgentSessionFirstMessage; deferred?: true } {
  const prompt = [...(staged.get(sessionId) ?? [])].find(
    (candidate) => !candidate.discarded && !candidate.delivery
  )
  if (!prompt) {
    return {}
  }
  // A prompt still naming a browser file is not the create's to send: after create, the ordinary send
  // reaches the one place that admits a body (and refuses this one with its notice).
  if (
    (prompt.prepare && target.kind === 'environment') ||
    nativeChatBrowserFileReferences(prompt.text, prompt.attachments).length > 0
  ) {
    prompt.slot?.legacy()
    return { deferred: true }
  }
  prompt.createOwned = true
  const sent = prompt.slot?.create(target)
  prompt.createSend = sent ?? undefined
  // No create send: a reservation that already settled reports its own real outcome; with no
  // reservation at all, nothing took the message, so it is handed back here (never assumed).
  const slot = prompt.slot
  if (sent) {
    prompt.delivery = sent.outcome.then((outcome) => {
      unstageStructuredLaunchPrompt(prompt)
      return {
        delivered: outcome === 'recorded',
        inComposer: stagedPromptReturnedDurably(prompt, outcome),
        ...unconfirmedStructuredLaunchDelivery(outcome, sent.recorded)
      }
    })
  } else if (slot) {
    prompt.delivery = slot.outcome.then((outcome) => {
      unstageStructuredLaunchPrompt(prompt)
      return stagedDeliveryFromSlotOutcome(prompt, outcome)
    })
  } else {
    prompt.delivery = Promise.resolve(finishStagedLaunchPromptWithHandBack(prompt))
  }
  void prompt.delivery.then(prompt.settleCreate)
  if (sent && !takesSkills && sent.message.body.skills) {
    const { skills: _skills, ...body } = sent.message.body
    return { firstMessage: { ...sent.message, body } }
  }
  return { firstMessage: sent?.message }
}

/** Final create admission marks issue only while the original send operation still exists. */
export function issueStructuredLaunchPromptForCreate(sessionId: string): boolean {
  const prompt = [...(staged.get(sessionId) ?? [])].find((candidate) => candidate.createOwned)
  return prompt?.createSend?.issue() ?? false
}

export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (staged.get(sessionId)?.size ?? 0) > 0
}

/** Return launch text to the composer unless the sender retains it. Report draft-write failure in chat without blocking the caller; true means adopted. */
export function handBackStagedLaunchPrompt(prompt: StagedStructuredLaunchPrompt): boolean {
  if (prompt.callerKeepsText) {
    return false
  }
  try {
    return handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, prompt.attachments ?? [], prompt.skills)
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
