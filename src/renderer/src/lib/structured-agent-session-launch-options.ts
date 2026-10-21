import { useSyncExternalStore } from 'react'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import { STRUCTURED_LAUNCH_OPTION_IDS } from '../../../shared/native-chat-session-option-defaults'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt
} from './structured-agent-session-launch-recovery'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  type AgentSessionWriteFailure
} from '../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import {
  structuredAgentSessionModelOffers,
  type StructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** What the host runs as far as the launch knows: the create seed, then each accepted pick. */
  seed?: Readonly<Record<string, string>>
  /** Encoded picks made before publish; the launch applies them before it publishes. */
  held: Readonly<Record<string, string>>
  /** A paired server has not yet said what create seeds, so nothing can be picked against it. */
  seedPending?: true
}

export function initialStructuredLaunchSelection(
  intent: StructuredAgentSessionLaunchIntent
): StructuredLaunchSelection {
  return {
    seed: intent.seedOptions,
    held: {},
    ...(intent.target.kind !== 'local' && !intent.seedOptions ? { seedPending: true } : {})
  }
}

export type StructuredLaunchOptionOutcome =
  | { kind: 'accepted'; options: Readonly<Record<string, string>> }
  | { kind: 'refused'; failure: AgentSessionWriteFailure }
  | { kind: 'superseded' }

type OptionReply = (outcome: StructuredLaunchOptionOutcome) => void

const optionReplies = new WeakMap<StructuredLaunchState, Map<string, OptionReply>>()

function repliesFor(state: StructuredLaunchState): Map<string, OptionReply> {
  let replies = optionReplies.get(state)
  if (!replies) {
    replies = new Map()
    optionReplies.set(state, replies)
  }
  return replies
}

/**
 * Records a pick made while the launch has no fence to send it against. Null once the launch
 * has published or is gone: the pick then goes through the session like any other.
 */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string,
  /** The picker's list, under which a model pick keeps only the held values the model offers. */
  picker?: Pick<StructuredAgentSessionOptionState, 'catalog' | 'verifiedModelIds'>
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state || state.cancelled || state.callers.outcome === 'published') {
    return null
  }
  if (state.selection.seedPending) {
    return null
  }
  const replies = repliesFor(state)
  const held: Record<string, string> = {}
  // Each held value is the chat's own: a pick supersedes an earlier pick of the same option.
  for (const [key, value] of Object.entries(state.selection.held)) {
    const offered =
      id !== 'model' || !picker || structuredAgentSessionModelOffers(picker, encoded, key, value)
    if (key !== id && offered) {
      held[key] = value
    } else {
      replies.get(key)?.({ kind: 'superseded' })
      replies.delete(key)
    }
  }
  state.selection = { ...state.selection, held: { ...held, [id]: encoded } }
  notifyStructuredLaunchListeners()
  return new Promise((resolve) => replies.set(id, resolve))
}

async function setLaunchOption(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  key: string,
  value: string
): Promise<StructuredLaunchOptionOutcome> {
  const fields = { key, value }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(target, 'agentSession.setOption', {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(createBrowserUuid),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId,
          fields
        })
      },
      ...fields
    })
    return result.ok
      ? { kind: 'accepted', options: result.value.options ?? { [key]: value } }
      : { kind: 'refused', failure: agentSessionRefusalFailure(result.refusal) }
  } catch (error) {
    return {
      kind: 'refused',
      failure: agentSessionThrownFailure(
        error,
        error instanceof RuntimeRpcCallError ? error.code : undefined
      )
    }
  }
}

function settleHeldOption(
  state: StructuredLaunchState,
  id: string,
  encoded: string,
  outcome: StructuredLaunchOptionOutcome
): void {
  const {
    held: { [id]: current, ...rest },
    seed
  } = state.selection
  // A pick made while this one was in flight superseded it and stays held for the next pass.
  const settled = current === encoded
  state.selection = {
    seed: outcome.kind === 'accepted' ? { ...seed, ...outcome.options } : seed,
    held: settled ? rest : state.selection.held
  }
  if (settled) {
    const replies = repliesFor(state)
    replies.get(id)?.(outcome)
    replies.delete(id)
  }
  notifyStructuredLaunchListeners()
  state.callers.onSettled()
}

const createHeld = new WeakMap<StructuredLaunchState, Readonly<Record<string, string>>>()

/** The held picks this create attempt carries, in whatever form it carries them. */
export function holdStructuredLaunchCreatePicks(
  state: StructuredLaunchState,
  held: Readonly<Record<string, string>>
): void {
  createHeld.set(state, held)
}

/** Selections included in the durable create are already the host's option intent; a pick the
 *  create carried in another form settles too, and a newer pick stays held. */
export function settleStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  options: Readonly<Record<string, string>>
): void {
  const carried = { ...options, ...createHeld.get(state) }
  createHeld.delete(state)
  for (const [id, encoded] of Object.entries(carried)) {
    settleHeldOption(state, id, encoded, { kind: 'accepted', options })
  }
}

/**
 * Applies the picks held during launch against the create receipt's fence, model first so an
 * effort lands under the model it was picked against, until none is left. A refused pick is
 * reported to its picker and never keeps the launch from publishing.
 */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  for (;;) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    const { held } = state.selection
    const id = STRUCTURED_LAUNCH_OPTION_IDS.find((key) => held[key] !== undefined)
    const encoded = id ? held[id] : undefined
    if (!id || encoded === undefined) {
      return receipt
    }
    const outcome = await setLaunchOption(
      state.intent.target,
      state.intent.sessionId,
      receipt.fence,
      id,
      encoded
    )
    settleHeldOption(state, id, encoded, outcome)
  }
}

export function getStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return getStructuredLaunchStateBySessionId(sessionId)?.selection ?? null
}

/** The launch's selection while it is in the registry; null before and after. */
export function useStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchSelection(sessionId),
    () => null
  )
}
