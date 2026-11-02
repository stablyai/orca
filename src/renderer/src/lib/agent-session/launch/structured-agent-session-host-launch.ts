/** A new workspace's chat whose executing host owns the wait for that workspace's required Setup and
 *  the one surface that follows it: agent.launchAccept, then bounded agent.launchStatus reads. The
 *  window adopts what the host reports; no answer lets it start another surface itself. */

import type { AgentLaunchResult } from '../../../../../shared/agent-launch-intent'
import type { AgentSessionHistoryResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import {
  AGENT_LAUNCH_STATUS_MAX_WAIT_MS,
  type AgentLaunchAcceptParams,
  type AgentLaunchAcceptResult,
  type AgentLaunchSetupReceipt,
  type AgentLaunchStatusResult,
  type AgentLaunchTerminalStartupParams
} from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/runtime-rpc-error-code'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { requiredSetupLaunchFailureText } from '@/lib/required-setup-launch-failure'
import {
  abandonStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from '../../launch-structured-agent-session'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import {
  structuredChatUnavailableText,
  type StructuredLaunchFailure
} from './structured-agent-session-launch-failure'
import { structuredAgentLabel } from './structured-agent-session-launch-label'
import { prepareLegacyStructuredLaunchPrompts } from './structured-agent-session-launch-prompt'
import {
  hostLaunchMessageAcknowledged,
  releaseHostLaunchMessage
} from './structured-agent-session-host-launch-custody'
import { requireHostPermission } from './structured-agent-session-launch-create-call'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'

export type StructuredHostLaunch = {
  /** Minted once per user action and reused by every retry of it, so the host runs it at most once. */
  operationId: string
  sessionId: string
  /** The held message under the id the host's chat founds it with. Saved with the launch before
   *  accept, so a reload still holds it; dropped once the host's answer settles who has it. */
  firstMessage?: StructuredAgentSessionFirstMessage
  /** What accept carries; absent once restored after a reload, which only reads the launch. */
  accept?: {
    prompt?: { text: string; clientMessageId: string }
    presentation: 'focused' | 'background'
    /** What the workspace's creation said about the Setup this launch waits for. */
    setupReceipt: AgentLaunchSetupReceipt
    /** The caller's own terminal plan, which the host runs if it cannot run the chat; absent, a
     *  chat the host cannot run starts nothing. */
    terminalStartup?: AgentLaunchTerminalStartupParams
    /** Who asked for the launch, as the terminal it may become is counted. */
    launchSource?: string
  }
}

/** The host started the agent in a terminal instead of the chat; the chat's tab gives way to it. */
export class StructuredHostLaunchTerminalError extends StructuredAgentSessionCreateRefusalError {
  constructor(readonly result: AgentLaunchResult) {
    super('The host started the agent in a terminal.', 'structured_agent_session_unsupported')
    this.name = 'StructuredHostLaunchTerminalError'
  }
}

/** The host's launch ended before any agent started; `failure` is how the chat says why. */
export class StructuredHostLaunchNotStartedError extends StructuredAgentSessionCreateRefusalError {
  constructor(
    code: string,
    readonly failure: StructuredLaunchFailure | undefined,
    message?: string
  ) {
    super(message ?? code, code)
    this.name = 'StructuredHostLaunchNotStartedError'
  }
}

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

type HostLaunchAnswer = Extract<
  AgentLaunchStatusResult,
  { state: 'succeeded' | 'failed' | 'unknown' }
>

type ObservedHostLaunch = {
  intent: StructuredAgentSessionLaunchIntent
  visibilityUnknown: boolean
  onVisibilityChanged?: () => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function acceptHostLaunch(
  intent: StructuredAgentSessionLaunchIntent,
  hostLaunch: StructuredHostLaunch,
  accept: NonNullable<StructuredHostLaunch['accept']>
): Promise<AgentLaunchAcceptResult> {
  const prompt = accept.prompt?.text.trim() ? accept.prompt : undefined
  const params: AgentLaunchAcceptParams = {
    agent: intent.agent,
    operationId: hostLaunch.operationId,
    target: { kind: 'existing', worktree: intent.params.worktree },
    sessionId: intent.sessionId,
    nativeChatDefault: true,
    ...(prompt ? { prompt: { ...prompt, delivery: 'submit' as const } } : {}),
    presentation: accept.presentation,
    setupReceipt: accept.setupReceipt,
    ...(accept.terminalStartup ? { terminalStartup: accept.terminalStartup } : {}),
    ...(accept.launchSource ? { launchSource: accept.launchSource } : {})
  }
  return callRuntimeRpc<AgentLaunchAcceptResult>(intent.target, 'agent.launchAccept', params)
}

function readHostLaunchStatus(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string
): Promise<AgentLaunchStatusResult> {
  return callRuntimeRpc<AgentLaunchStatusResult>(
    intent.target,
    'agent.launchStatus',
    { operationId, waitMs: AGENT_LAUNCH_STATUS_MAX_WAIT_MS },
    { timeoutMs: HOST_LAUNCH_STATUS_TIMEOUT_MS }
  )
}

/** Reads until the host settles the launch. A lost reply sends the same request again, which names
 *  the same launch; nothing here ever starts a second one. */
async function awaitHostLaunchAnswer(
  intent: StructuredAgentSessionLaunchIntent,
  hostLaunch: StructuredHostLaunch,
  throwIfCancelled: () => void,
  onAccepted: () => void
): Promise<HostLaunchAnswer> {
  const { accept } = hostLaunch
  let accepted = accept === undefined
  let misses = 0
  for (;;) {
    throwIfCancelled()
    let answer: AgentLaunchStatusResult
    try {
      answer =
        accepted || !accept
          ? await readHostLaunchStatus(intent, hostLaunch.operationId)
          : await acceptHostLaunch(intent, hostLaunch, accept)
    } catch (error) {
      const refusal = HOST_LAUNCH_REQUEST_REFUSALS.find((code) =>
        hasRuntimeRpcErrorCode(error, code)
      )
      if (refusal) {
        return { state: 'failed', code: refusal }
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
    if (answer.state === 'running') {
      misses = 0
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

function notStartedFailure(
  intent: StructuredAgentSessionLaunchIntent,
  code: string
): StructuredLaunchFailure | undefined {
  if (code === 'agent_launch_setup_not_completed') {
    return {
      kind: 'not-started',
      causeText: requiredSetupLaunchFailureText(structuredAgentLabel(intent.agent))
    }
  }
  // No terminal was planned for a chat the host cannot run, as the same create opens none.
  return code === 'agent_launch_surface_unavailable'
    ? {
        kind: 'refused',
        code: 'structured_agent_session_unsupported',
        causeText: structuredChatUnavailableText()
      }
    : undefined
}

function markUnknown(state: ObservedHostLaunch): Error {
  // Possibly the host's now: a copy goes back to the composer, and nothing sends it again.
  releaseHostLaunchMessage(state.intent, false)
  state.visibilityUnknown = true
  state.onVisibilityChanged?.()
  return new Error('agent_session_operation_unknown')
}

/** The chat the host founded with the held message: read its fence as a create reply would carry. */
async function adoptHostLaunchedChat(
  state: ObservedHostLaunch,
  result: AgentLaunchResult
): Promise<StructuredAgentLaunchReceipt> {
  const { intent } = state
  let history: AgentSessionHistoryResult
  try {
    history = await callStructuredAgentSession<AgentSessionHistoryResult>(
      intent.target,
      'agentSession.history',
      { sessionId: intent.sessionId, direction: 'tail', limit: 1 }
    )
  } catch {
    throw markUnknown(state)
  }
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw markUnknown(state)
  }
  releaseHostLaunchMessage(intent, hostLaunchMessageAcknowledged(result))
  publishStructuredAgentSessionCreateHydration(intent, history.page, fence)
  return { sessionId: intent.sessionId, fence }
}

export async function observeStructuredHostLaunch(
  state: ObservedHostLaunch,
  hostLaunch: StructuredHostLaunch,
  throwIfCancelled: () => void
): Promise<StructuredAgentLaunchReceipt> {
  const { intent } = state
  // The held message waits with the host's Setup, not on its send's own deadline.
  prepareLegacyStructuredLaunchPrompts(intent.sessionId)
  if (hostLaunch.accept) {
    await requireHostPermission(intent)
  }
  const answer = await awaitHostLaunchAnswer(intent, hostLaunch, throwIfCancelled, () => {
    // The host holds it now: a later read of this launch never sends accept again.
    const { accept: _held, ...accepted } = hostLaunch
    intent.hostLaunch = accepted
  })
  throwIfCancelled()
  if (answer.state === 'unknown') {
    throw markUnknown(state)
  }
  if (answer.state === 'failed') {
    releaseHostLaunchMessage(intent, false)
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredHostLaunchNotStartedError(
      answer.code,
      notStartedFailure(intent, answer.code),
      answer.message
    )
  }
  const { outcome } = answer.result
  if (outcome.kind === 'terminal') {
    // A terminal existing is no receipt for the text: only the host's word on it lets it go.
    releaseHostLaunchMessage(intent, hostLaunchMessageAcknowledged(answer.result))
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredHostLaunchTerminalError(answer.result)
  }
  if (outcome.sessionId !== intent.sessionId) {
    throw markUnknown(state)
  }
  return adoptHostLaunchedChat(state, answer.result)
}
