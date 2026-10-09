import { useSyncExternalStore } from 'react'
import type {
  AgentSessionMutationResult,
  AgentSessionHistoryResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import {
  STRUCTURED_LAUNCH_HELD_OPTION_IDS,
  STRUCTURED_LAUNCH_SEED_OPTION_IDS
} from '../../../shared/native-chat-session-option-defaults'
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
import type { AgentSessionPermissionFact } from '../../../shared/agent-chat-permission-mode'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** What the host runs as far as the launch knows: the create seed, then each accepted pick. */
  seed?: Readonly<Record<string, string>>
  /** Encoded picks made before publish; the launch applies them before it publishes. */
  held: Readonly<Record<string, string>>
}

export type StructuredLaunchOptionOutcome =
  | {
      kind: 'accepted'
      options: Readonly<Record<string, string>>
      permissionFact?: AgentSessionPermissionFact
    }
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
 * Holds pre-create picks; after publication, the host supplies the fence before the same write.
 */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string,
  publishedTarget?: RuntimeClientTarget
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state?.cancelled) {
    return null
  }
  if (!state || state.callers.outcome === 'published') {
    return publishedTarget ? setLaunchOption(publishedTarget, sessionId, null, id, encoded) : null
  }
  const replies = repliesFor(state)
  const { held } = state.selection
  // A model pick drops picks held under the model it replaces; the chat's own picks stay.
  const perModel = new Set<string>(STRUCTURED_LAUNCH_SEED_OPTION_IDS)
  const superseded = id === 'model' ? Object.keys(held).filter((key) => perModel.has(key)) : [id]
  for (const key of superseded) {
    replies.get(key)?.({ kind: 'superseded' })
    replies.delete(key)
  }
  const kept = Object.fromEntries(Object.entries(held).filter(([key]) => !superseded.includes(key)))
  state.selection = { ...state.selection, held: { ...kept, [id]: encoded } }
  notifyStructuredLaunchListeners()
  return new Promise((resolve) => replies.set(id, resolve))
}

async function setLaunchOption(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number | null,
  key: string,
  value: string
): Promise<StructuredLaunchOptionOutcome> {
  const fields = { key, value }
  try {
    if (fence === null) {
      const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
        target,
        'agentSession.history',
        { sessionId, direction: 'tail', limit: 1 }
      )
      fence = history.page.fence ?? (!history.ok ? history.fence : undefined) ?? null
      if (fence === null) {
        throw new Error('structured session fence publication unavailable')
      }
    }
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
      ? {
          kind: 'accepted',
          options: result.value.options ?? { [key]: value },
          permissionFact: result.value.permissionFact
        }
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
    const id = STRUCTURED_LAUNCH_HELD_OPTION_IDS.find((key) => held[key] !== undefined)
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
