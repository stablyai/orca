import { useSyncExternalStore } from 'react'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../shared/native-chat/input/native-chat-session-option-defaults'
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
} from './agent-session/launch/structured-agent-session-launch-recovery'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  type AgentSessionWriteFailure
} from '../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** What the host runs as far as the launch knows: the create seed, then each accepted pick. */
  seed?: Readonly<Record<string, string>>
  /** Read-only projection of durable action input; held contains only subsequent edits. */
  explicit?: Readonly<Record<string, string>>
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
    ...(intent.explicitLaunchOptions ? { explicit: intent.explicitLaunchOptions } : {}),
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

/** Hold picks only before publication; published/missing launches use the normal session option path. */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string
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
    if (key !== id) {
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
    explicit: state.selection.explicit,
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

/** Old hosts configure the known chat before submitting; Fast keeps saved-preference admission. */
export async function applyStructuredLaunchExplicitOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  const requested = structuredLaunchRequestedOptions({
    explicit: state.selection.explicit,
    held: state.selection.held
  })
  if (!requested) {
    return applyStructuredLaunchHeldOptions(state, receipt)
  }
  const compatible = structuredLaunchCompatibleOptions(state.intent.agent, requested)
  const entries = Object.entries(compatible).sort(([a], [b]) =>
    a === 'model' ? -1 : b === 'model' ? 1 : 0
  )
  for (const [id, encoded] of entries) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (id === 'fastMode' && state.selection.held[id] === undefined) {
      continue
    }
    const outcome = await setLaunchOption(
      state.intent.target,
      receipt.sessionId,
      receipt.fence,
      id,
      encoded
    )
    settleHeldOption(state, id, encoded, outcome)
    if (outcome.kind === 'refused' && requested[id] !== undefined) {
      for (const [key, value] of Object.entries(state.selection.held)) {
        settleHeldOption(state, key, value, outcome)
      }
      return { ...receipt, configurationFailure: outcome.failure }
    }
  }
  return applyStructuredLaunchHeldOptions(state, receipt)
}

const createHeld = new WeakMap<StructuredLaunchState, Readonly<Record<string, string>>>()

/** The held picks this create attempt carries, in whatever form it carries them. */
export function holdStructuredLaunchCreatePicks(
  state: StructuredLaunchState,
  held: Readonly<Record<string, string>>
): void {
  createHeld.set(state, held)
}

// Durable-create picks already count as host intent; settle carried values while retaining newer choices.
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

/** Apply held picks against the create fence until drained, model before effort. Report refusals to pickers without blocking launch publication. */
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
