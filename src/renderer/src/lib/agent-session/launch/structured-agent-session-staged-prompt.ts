import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'
import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  type StructuredAgentSessionCreateSend,
  type StructuredAgentSessionReservedSend
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/messages/notices/agent-session-write-notice-text'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { StructuredAgentSessionSendInput } from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-slot'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-callers'

type LaunchMessage = Pick<StructuredAgentSessionSendInput, 'text' | 'attachments' | 'skills'>

export type StagedDelivery = Omit<
  StructuredPromptDeliveryResult,
  'inComposer' | 'failureNotified'
> & {
  inComposer: boolean
  failureNotified?: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  promptAttachments?: StructuredAgentSessionSendInput['attachments']
  promptSkills?: StructuredAgentSessionSendInput['skills']
  preparePrompt?: (sessionId: string, target: RuntimeClientTarget) => Promise<LaunchMessage>
}

/** Share one staged-text send across launch callers; reserve the chat send slot at click so typed messages cannot overtake it before create. */
export type StagedStructuredLaunchPrompt = {
  sessionId: string
  text: string
  attachments?: LaunchMessage['attachments']
  skills?: LaunchMessage['skills']
  prepare?: StructuredLaunchPromptOptions['preparePrompt']
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
  let settleCreate = (_outcome: StagedDelivery): void => {}
  const whenCreateSettled = new Promise<StagedDelivery>((resolve) => {
    settleCreate = resolve
  })
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
    settleCreate
  }
  const forSession = staged.get(sessionId) ?? new Set()
  forSession.add(prompt)
  staged.set(sessionId, forSession)
  void prompt.slot?.outcome.then((outcome) => {
    const result: StagedDelivery = {
      delivered: outcome === 'recorded',
      inComposer: !prompt.callerKeepsText && outcome === 'returned',
      ...(outcome === 'unconfirmed' ? { unconfirmed: true } : {})
    }
    if (!prompt.delivery) {
      prompt.delivery = Promise.resolve(result)
      unstageStructuredLaunchPrompt(prompt)
    }
    prompt.settleCreate(result)
  })
  return prompt
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
}

// Prepublication Stop returns unsent text to the composer while allowing chat startup to continue.
export function takeBackLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.delivery || prompt.createOwned) {
      continue
    }
    unstageStructuredLaunchPrompt(prompt)
    prompt.discarded = true
    const inComposer = handBackStagedLaunchPrompt(prompt)
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
  target: RuntimeClientTarget,
  takesSkills = false
): { firstMessage?: StructuredAgentSessionFirstMessage; deferred?: true } {
  const prompt = [...(staged.get(sessionId) ?? [])].find(
    (candidate) => !candidate.discarded && !candidate.delivery
  )
  if (!prompt) {
    return {}
  }
  if (prompt.prepare && target.kind === 'environment') {
    prompt.slot?.legacy()
    return { deferred: true }
  }
  prompt.createOwned = true
  const sent = prompt.slot?.create(target)
  prompt.createSend = sent ?? undefined
  prompt.delivery = sent
    ? sent.outcome.then((outcome) => {
        unstageStructuredLaunchPrompt(prompt)
        return {
          delivered: outcome === 'recorded',
          inComposer: !prompt.callerKeepsText && outcome === 'returned',
          ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
        }
      })
    : Promise.resolve({ delivered: false, inComposer: !prompt.callerKeepsText }).then((outcome) => {
        unstageStructuredLaunchPrompt(prompt)
        return outcome
      })
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
