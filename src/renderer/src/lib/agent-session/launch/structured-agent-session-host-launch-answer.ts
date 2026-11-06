/** How the window reads its host's launch to an answer: accept or prepare once, then bounded status
 *  reads, releasing the first turn when the host awaits it. A lost reply sends the same request
 *  again, which names the same launch; nothing here ever starts a second one. */

import {
  AGENT_LAUNCH_STATUS_MAX_WAIT_MS,
  type AgentLaunchAcceptParams,
  type AgentLaunchAcceptResult,
  type AgentLaunchReleasePhaseStatusResult
} from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import type { AgentLaunchPrepareParams } from '../../../../../shared/rpc-contract/agent-launch-release-params'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/runtime-rpc-error-code'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  PromiseSettlementWaiters,
  sharedPromiseSettlementWaiters
} from '../../../../../shared/promise-settlement-waiters'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import type { StructuredHostLaunch } from './structured-agent-session-host-launch'
import {
  forgetHostLaunchPreparation,
  HostLaunchInputUnavailableError,
  releaseHostLaunchFirstTurn
} from './structured-agent-session-host-launch-release'

// Refusals of the request itself: the host never ran it, and resending cannot change that.
const HOST_LAUNCH_REQUEST_REFUSALS = [
  'agent_session_operation_conflict',
  'agent_session_operation_invalid',
  'agent_session_operation_expired'
] as const
// A new workspace may not resolve for a beat after its create, and a reply can be lost; past these
// the launch reads as unknown until a reconnect or Retry reads it again.
const HOST_LAUNCH_RETRY_DELAYS_MS: readonly number[] = [100, 400, 1500]
// A status read holds its reply up to the host's limit; the request outlives it by a margin only.
const HOST_LAUNCH_STATUS_TIMEOUT_MS = AGENT_LAUNCH_STATUS_MAX_WAIT_MS + 5_000

export type HostLaunchAnswer = Extract<
  AgentLaunchReleasePhaseStatusResult,
  { state: 'succeeded' | 'failed' | 'unknown' }
>

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function acceptHostLaunch(
  intent: StructuredAgentSessionLaunchIntent,
  hostLaunch: StructuredHostLaunch,
  accept: NonNullable<StructuredHostLaunch['accept']>
): Promise<AgentLaunchAcceptResult> {
  const params = {
    agent: intent.agent,
    operationId: hostLaunch.operationId,
    target: { kind: 'existing' as const, worktree: intent.params.worktree },
    sessionId: intent.sessionId,
    nativeChatDefault: true,
    presentation: accept.presentation,
    setupReceipt: accept.setupReceipt,
    ...(accept.launchSource ? { launchSource: accept.launchSource } : {})
  }
  if (hostLaunch.protocol === 'release') {
    // The same launch without its final choices or message body, which release brings after Setup.
    const message = intent.opening
    const prepare: AgentLaunchPrepareParams = {
      ...params,
      ...(message
        ? { prompt: { delivery: 'submit', clientMessageId: message.clientMessageId } }
        : {}),
      terminalAlternative: accept.terminalAlternative ?? { kind: 'none' }
    }
    return callRuntimeRpc<AgentLaunchAcceptResult>(intent.target, 'agent.launchPrepare', prepare)
  }
  const prompt = accept.prompt?.text.trim() ? accept.prompt : undefined
  const acceptParams: AgentLaunchAcceptParams = {
    ...params,
    ...(prompt ? { prompt: { ...prompt, delivery: 'submit' as const } } : {}),
    ...(accept.terminalStartup ? { terminalStartup: accept.terminalStartup } : {})
  }
  return callRuntimeRpc<AgentLaunchAcceptResult>(intent.target, 'agent.launchAccept', acceptParams)
}

/** A launch with its first turn saved asks for the release phase; one without it never does, so a
 *  host waiting on input this window cannot supply is left to end the launch itself. */
function readHostLaunchStatus(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string,
  phase = true
): Promise<AgentLaunchReleasePhaseStatusResult> {
  const releasable =
    phase && intent.hostLaunch?.protocol === 'release' && intent.hostLaunch.firstTurn
  return callRuntimeRpc<AgentLaunchReleasePhaseStatusResult>(
    intent.target,
    'agent.launchStatus',
    {
      operationId,
      waitMs: AGENT_LAUNCH_STATUS_MAX_WAIT_MS,
      ...(releasable ? { includeReleasePhase: true } : {})
    },
    { timeoutMs: HOST_LAUNCH_STATUS_TIMEOUT_MS }
  )
}

type StatusRead = { waiters: PromiseSettlementWaiters<AgentLaunchReleasePhaseStatusResult> }

/** While a held message's files cannot reach the host, reads only whether the launch ended (each
 *  read held up to the host's limit), until an explicit Retry prepares the message again. One read
 *  is outstanding at a time: one a Retry overtook is waited on again rather than sent again, and
 *  each wait detaches from both promises once the other settles. */
async function readWhileParked(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string,
  resumed: Promise<void>,
  outstanding: { read?: StatusRead }
): Promise<AgentLaunchReleasePhaseStatusResult | 'resumed'> {
  let read = outstanding.read
  if (!read) {
    const owned: StatusRead = {
      waiters: new PromiseSettlementWaiters(
        readHostLaunchStatus(intent, operationId, false),
        () => {
          if (outstanding.read === owned) {
            delete outstanding.read
          }
        }
      )
    }
    read = owned
    outstanding.read = owned
  }
  const detach = new AbortController()
  try {
    return await Promise.race([
      sharedPromiseSettlementWaiters(resumed)
        .wait({ signal: detach.signal })
        .then(() => 'resumed' as const),
      read.waiters.wait({ signal: detach.signal })
    ])
  } finally {
    detach.abort()
  }
}

/** Whether the host's answer settles the launch, as opposed to it still running or awaiting. */
function settlesLaunch(answer: AgentLaunchReleasePhaseStatusResult): answer is HostLaunchAnswer {
  return answer.state === 'succeeded' || answer.state === 'failed' || answer.state === 'unknown'
}

/** A refused release says only that this request will not run; the launch's own record says
 *  whether it ended. One still live keeps its input and reads as unknown until a Retry. */
async function answerAfterRefusedRelease(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string,
  code: (typeof HOST_LAUNCH_REQUEST_REFUSALS)[number]
): Promise<HostLaunchAnswer> {
  try {
    const answer = await readHostLaunchStatus(intent, operationId, false)
    if (settlesLaunch(answer)) {
      return answer
    }
  } catch {
    // Unread: nothing says the launch ended.
  }
  console.warn('[native-chat] host launch release refused', code)
  return { state: 'unknown' }
}

/** Reads until the host settles the launch. A lost reply sends the same request again, which names
 *  the same launch; nothing here ever starts a second one. */
export async function awaitHostLaunchAnswer(
  intent: StructuredAgentSessionLaunchIntent,
  hostLaunch: StructuredHostLaunch,
  throwIfCancelled: () => void,
  onAccepted: () => void
): Promise<HostLaunchAnswer> {
  try {
    return await readHostLaunchAnswer(intent, hostLaunch, throwIfCancelled, onAccepted)
  } finally {
    forgetHostLaunchPreparation(intent.sessionId)
  }
}

async function readHostLaunchAnswer(
  intent: StructuredAgentSessionLaunchIntent,
  hostLaunch: StructuredHostLaunch,
  throwIfCancelled: () => void,
  onAccepted: () => void
): Promise<HostLaunchAnswer> {
  const { accept } = hostLaunch
  let accepted = accept === undefined
  let misses = 0
  // Set by the host saying it awaits this launch's first turn; the next request releases it.
  let releasing = false
  // Set while its message's files cannot reach the host; settles on an explicit Retry.
  let parked: Promise<void> | undefined
  const outstanding: { read?: StatusRead } = {}
  for (;;) {
    throwIfCancelled()
    let answer: AgentLaunchReleasePhaseStatusResult
    const released = releasing
    try {
      const read = parked
        ? await readWhileParked(intent, hostLaunch.operationId, parked, outstanding)
        : releasing
          ? await releaseHostLaunchFirstTurn(intent, hostLaunch.operationId)
          : accepted || !accept
            ? await (outstanding.read?.waiters.wait() ??
                readHostLaunchStatus(intent, hostLaunch.operationId))
            : await acceptHostLaunch(intent, hostLaunch, accept)
      if (read === 'resumed') {
        parked = undefined
        releasing = true
        continue
      }
      answer = read
    } catch (error) {
      releasing = false
      if (error instanceof HostLaunchInputUnavailableError) {
        // Nothing released or given back: the same live launch waits for the input to be prepared.
        parked = error.resumed
        continue
      }
      const refusal = HOST_LAUNCH_REQUEST_REFUSALS.find((code) =>
        hasRuntimeRpcErrorCode(error, code)
      )
      if (refusal) {
        return released
          ? answerAfterRefusedRelease(intent, hostLaunch.operationId, refusal)
          : { state: 'failed', code: refusal }
      }
      const wait = HOST_LAUNCH_RETRY_DELAYS_MS[misses++]
      if (wait === undefined) {
        return { state: 'unknown' }
      }
      await delay(wait)
      continue
    }
    if (answer.state !== 'absent' && !accepted) {
      accepted = true
      onAccepted()
    }
    // Awaiting its first turn: release next. A release that keeps failing still counts as a miss,
    // so a host that keeps asking is never answered in a tight loop.
    releasing = answer.state === 'awaiting-release'
    if (answer.state === 'running' || answer.state === 'awaiting-release') {
      misses = releasing ? misses : 0
      continue
    }
    if (answer.state !== 'absent') {
      return answer
    }
    // Accept never reached the host. Only the window that holds the request may send it again.
    const wait = accept ? HOST_LAUNCH_RETRY_DELAYS_MS[misses++] : undefined
    if (wait === undefined) {
      return { state: 'unknown' }
    }
    accepted = false
    await delay(wait)
  }
}
