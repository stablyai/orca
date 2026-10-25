import {
  handBackStagedPrompt,
  sendStagedPrompt
} from './structured-agent-session-launch-prompt-delivery'

import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { agentSessionThrownFailure } from '../../../shared/agent-session-write-failure'

import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  type StructuredAgentSessionCreateSend,
  type StructuredAgentSessionReservedSend
} from '@/components/native-chat/structured-agent-session-message-sender'

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { HostCreatedPrompt } from './structured-agent-session-host-prompt'
import {
  hostPanePromptKey,
  hostTabPromptKey,
  hostPromptIndexKey
} from './structured-agent-session-host-launch-prompt'
export {
  stageHostCreatedLaunchPrompt,
  settleHostCreatedLaunchResult,
  noteHostCreatedLaunchRead,
  markHostCreatedLaunchUnconfirmed,
  dismissHostCreatedLaunchPrompt,
  abandonHostCreatedLaunchPrompts,
  abandonHostCreatedLaunchPane,
  abandonHostCreatedLaunchTab,
  noteHostCreatedLaunchTargets
} from './structured-agent-session-host-launch-prompt'

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

export type StagedDelivery = Omit<
  StructuredPromptDeliveryResult,
  'inComposer' | 'failureNotified'
> & {
  inComposer: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

type LaunchReceipt = StructuredAgentLaunchReceipt

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
  hostCreate?: HostCreatedPrompt
  whenCreateSettled: Promise<StagedDelivery>
  settleCreate: (outcome: StagedDelivery) => void
  /** Its launch was cancelled: never sent, never given back. */
  discarded?: true
  /** Settles once it is discarded, so its callers need not wait on a create that may never end. */
  whenDiscarded: Promise<void>
  discard: () => void
}

export const stagedStructuredLaunchPrompts = new Map<string, Set<StagedStructuredLaunchPrompt>>()

export function stageStructuredLaunchPrompt(
  sessionId: string,
  text: string,
  options: { callerKeepsText?: true; clientMessageId?: string; reserve?: false } = {}
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
    slot:
      options.reserve === false
        ? null
        : reserveStructuredAgentSessionSend({ sessionId, text, ...options }),
    ...options,
    whenDiscarded,
    discard,
    whenCreateSettled,
    settleCreate
  }
  const forSession = stagedStructuredLaunchPrompts.get(sessionId) ?? new Set()
  forSession.add(prompt)
  stagedStructuredLaunchPrompts.set(sessionId, forSession)
  void prompt.slot?.outcome.then((outcome) => {
    const result: StagedDelivery = {
      delivered: outcome === 'recorded',
      inComposer: !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
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
  // Alias removal must precede sender notifications or draft listeners.
  if (prompt.hostCreate) {
    const hostKey = hostPromptIndexKey(prompt.hostCreate.executionHostId)
    const forHost = stagedStructuredLaunchPrompts.get(hostKey)
    forHost?.delete(prompt)
    if (forHost?.size === 0) {
      stagedStructuredLaunchPrompts.delete(hostKey)
    }
    stagedStructuredLaunchPrompts.delete(
      hostTabPromptKey(prompt.hostCreate.executionHostId, prompt.hostCreate.pane.tabId)
    )
    stagedStructuredLaunchPrompts.delete(
      hostPanePromptKey(
        prompt.hostCreate.executionHostId,
        prompt.hostCreate.pane.tabId,
        prompt.hostCreate.pane.leafId
      )
    )
  }
  const forSession = stagedStructuredLaunchPrompts.get(prompt.sessionId)
  forSession?.delete(prompt)
  if (forSession?.size === 0) {
    stagedStructuredLaunchPrompts.delete(prompt.sessionId)
  }
  prompt.slot?.release()
}

/** The launch was cancelled: what it staged is dropped with its chat. */
export function discardStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of stagedStructuredLaunchPrompts.get(sessionId) ?? []) {
    unstageStructuredLaunchPrompt(prompt)
    prompt.createSend?.drop()
    prompt.discarded = true
    prompt.discard()
  }
  stagedStructuredLaunchPrompts.delete(sessionId)
}

/** The chat is closing or its launch was cancelled: nothing it was sending goes out any more. */
export function discardStructuredAgentSessionChatSends(sessionId: string): void {
  discardStructuredLaunchPrompts(sessionId)
  dropStructuredAgentSessionSends(sessionId)
}

/** A Stop before the chat is published: text its launch has not sent goes back to the composer,
 *  never sent. The start itself goes on. */
export function takeBackLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of stagedStructuredLaunchPrompts.get(sessionId) ?? []) {
    if (prompt.delivery || prompt.createOwned) {
      continue
    }
    unstageStructuredLaunchPrompt(prompt)
    prompt.discarded = true
    handBackStagedPrompt(prompt)
    prompt.discard()
  }
}

export function prepareLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of stagedStructuredLaunchPrompts.get(sessionId) ?? []) {
    prompt.slot?.legacy()
  }
}

/** Transfers the first staged prompt to create, retaining the sender's deadline and bubble. */
export function prepareStructuredLaunchPromptForCreate(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionFirstMessage | undefined {
  const prompt = [...(stagedStructuredLaunchPrompts.get(sessionId) ?? [])].find(
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
        unstageStructuredLaunchPrompt(prompt)
        return {
          delivered: outcome === 'recorded',
          inComposer:
            !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
          ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
        }
      })
    : Promise.resolve({ delivered: false, inComposer: !prompt.callerKeepsText }).then((outcome) => {
        unstageStructuredLaunchPrompt(prompt)
        return outcome
      })
  void prompt.delivery.then(prompt.settleCreate)
  return sent?.message
}

/** Whether a launch still holds text for this chat that has not reached its host. */
export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (stagedStructuredLaunchPrompts.get(sessionId)?.size ?? 0) > 0
}

/** Delivers the create's reserved text, if Stop or close has not already handed it back. */
export function sendStagedStructuredLaunchPrompt(
  sessionId: string,
  target: RuntimeClientTarget
): Promise<StagedDelivery> | undefined {
  const prompt = [...(stagedStructuredLaunchPrompts.get(sessionId) ?? [])].find(
    (candidate) => !candidate.discarded
  )
  return prompt ? sendStagedPrompt(prompt, null, target, unstageStructuredLaunchPrompt) : undefined
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
            ? { kind: 'recorded', submission: receipt.firstMessage, cursor: receipt.cursor }
            : { kind: 'unconfirmed' }
        )
      }
      const { delivered, inComposer, unconfirmed, busy } = await sendStagedPrompt(
        prompt,
        receipt,
        args.target,
        unstageStructuredLaunchPrompt
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
        unstageStructuredLaunchPrompt(prompt)
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
