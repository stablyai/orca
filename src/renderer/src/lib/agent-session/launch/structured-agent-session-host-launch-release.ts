/** A host launch prepared before its workspace's Setup finished takes its first turn's final choices
 *  only once the host says Setup succeeded. Until then the chat's picker edits that first turn; the
 *  window then reads the picks in one synchronous step, saves them as submitted and sends them, so
 *  every pick made before that step governs the first turn and any later one is a next-turn choice.
 *  A lost reply sends the same saved input again; nothing is ever read twice. */

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  AgentLaunchReleaseParams,
  AgentLaunchReleaseResult
} from '../../../../../shared/rpc-contract/agent-launch-release-params'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import { captureStructuredLaunchFirstTurn } from './structured-agent-session-launch-create-message'
import type { HostLaunchFirstTurn } from './structured-agent-session-launch-record'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

type ReleasedInput = Omit<HostLaunchFirstTurn, 'phase'>

/** The launch this window still holds for the intent; any other has been retired or replaced, and
 *  its own cancellation check ends the read. */
function heldLaunchState(intent: StructuredAgentSessionLaunchIntent): StructuredLaunchState {
  const state = getStructuredLaunchStateBySessionId(intent.sessionId)
  if (!state || state.intent !== intent || state.cancelled) {
    throw new Error('host launch no longer held')
  }
  return state
}

/** The chat's picks as its first turn would carry them. The host takes a per-message selection
 *  and explicit options, so selection is always present, empty included: its absence must never
 *  let the host bring back a remembered model or effort. */
function readFirstTurn(state: StructuredLaunchState, freeze: boolean): ReleasedInput {
  const { options, optionsMode, selection } = captureStructuredLaunchFirstTurn(state, {
    hostTakesExplicitOptions: true,
    selection: true,
    ...(freeze ? {} : { freeze: false as const })
  })
  return {
    options: { ...options },
    ...(optionsMode ? { optionsMode } : {}),
    selection: { ...selection }
  }
}

function saveFirstTurn(
  intent: StructuredAgentSessionLaunchIntent,
  firstTurn: HostLaunchFirstTurn
): void {
  if (intent.hostLaunch) {
    intent.hostLaunch = { ...intent.hostLaunch, firstTurn }
  }
  // Saved with the launch's row and shown: a failed save never holds the launch back.
  notifyStructuredLaunchListeners()
}

/** Saves the choices the chat shows as the launch starts, so a reload can still finish them. */
export function recordHostLaunchFirstTurnBaseline(
  intent: StructuredAgentSessionLaunchIntent
): void {
  const state = getStructuredLaunchStateBySessionId(intent.sessionId)
  if (
    intent.hostLaunch?.protocol !== 'release' ||
    intent.hostLaunch.firstTurn ||
    state?.intent !== intent
  ) {
    return
  }
  saveFirstTurn(intent, { phase: 'editing', ...readFirstTurn(state, false) })
}

/** Hands the host its first turn: the input already submitted, unchanged, or else the chat's picks
 *  of now. Reading, saving and sending happen in this one synchronous step. */
export function releaseHostLaunchFirstTurn(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string
): Promise<AgentLaunchReleaseResult> {
  let firstTurn = intent.hostLaunch?.firstTurn
  if (!firstTurn) {
    // Nothing says what this turn runs with; no default stands in for it.
    throw new Error('host launch first turn unavailable')
  }
  if (firstTurn.phase !== 'submitted') {
    firstTurn = { phase: 'submitted', ...readFirstTurn(heldLaunchState(intent), true) }
    saveFirstTurn(intent, firstTurn)
  }
  const { phase: _submitted, ...input } = firstTurn
  const params: AgentLaunchReleaseParams = { operationId, ...input }
  return callRuntimeRpc<AgentLaunchReleaseResult>(intent.target, 'agent.launchRelease', params)
}
