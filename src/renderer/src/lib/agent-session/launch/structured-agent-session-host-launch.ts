/** A new workspace's chat whose executing host owns the wait for that workspace's required Setup and
 *  the one surface that follows it: agent.launchAccept, then bounded agent.launchStatus reads. The
 *  window adopts what the host reports; no answer lets it start another surface itself. */

import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { AgentSessionHistoryResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import type {
  AgentLaunchSetupReceipt,
  AgentLaunchTerminalStartupParams
} from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import type { AgentLaunchTerminalAlternativeParams } from '../../../../../shared/rpc-contract/agent-launch-release-params'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { requiredSetupLaunchFailureText } from '@/lib/required-setup-launch-failure'
import {
  abandonStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from '../../launch-structured-agent-session'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import {
  structuredChatNotStartedText,
  type StructuredLaunchFailure
} from './structured-agent-session-launch-failure'
import { structuredAgentLabel } from './structured-agent-session-launch-label'
import {
  holdStructuredLaunchPromptsForLaunch,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import {
  hostLaunchMessageAcknowledged,
  releaseHostLaunchMessage
} from './structured-agent-session-host-launch-custody'
import { requireHostPermission } from './structured-agent-session-launch-create-call'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import type { HostLaunchFirstTurn } from './structured-agent-session-launch-record'
import { recordHostLaunchFirstTurnBaseline } from './structured-agent-session-host-launch-release'
import { awaitHostLaunchAnswer } from './structured-agent-session-host-launch-answer'
import type { HostLaunchSources } from './structured-agent-session-host-launch-sources'

export type StructuredHostLaunch = {
  /** Minted once per user action and reused by every retry of it, so the host runs it at most once. */
  operationId: string
  sessionId: string
  /** The opening's client files the host must receive before release, as the staging owner holds
   *  them. The opening itself is the launch's own (`intent.opening`). */
  stagedSources?: readonly string[]
  /** Holds those files until no operation needs them, and uploads them under this launch for the
   *  opening as it is when released; in memory only. */
  sources?: HostLaunchSources
  /** Prepared, then released with the first turn's final choices once the host's Setup succeeded;
   *  absent, accepted whole. Kept for the launch, and saved as `firstTurn` being present. */
  protocol?: 'release'
  /** The first turn release hands the host, saved with the launch; absent after a reload that
   *  could not read it, when nothing is released and the launch is left to the host's expiry. */
  firstTurn?: HostLaunchFirstTurn
  /** What accept carries; absent once restored after a reload, which only reads the launch. A
   *  prepared launch names its opening by id instead, whose body release carries. */
  accept?: {
    prompt?: { text: string; clientMessageId: string }
    presentation: 'focused' | 'background'
    /** What the workspace's creation said about the Setup this launch waits for. */
    setupReceipt: AgentLaunchSetupReceipt
    /** The caller's own terminal plan, which the host runs if it cannot run the chat; absent, a
     *  chat the host cannot run starts nothing. */
    terminalStartup?: AgentLaunchTerminalStartupParams
    /** Prepare's form of it: what the planner compiles, with the released choices, on the host. */
    terminalAlternative?: AgentLaunchTerminalAlternativeParams
    /** Who asked for the launch, as the terminal it may become is counted. */
    launchSource?: string
  }
}

/** A creation's host launch with the message its chat opens with, which becomes the launch's
 *  opening as the launch starts. */
export type StructuredHostLaunchHandoff = StructuredHostLaunch & {
  opening?: StructuredAgentSessionFirstMessage
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

// The host refused the released message whole: a file it names is no longer stored there.
const HOST_LAUNCH_ATTACHMENT_EXPIRED = 'agent_launch_attachment_expired'

type ObservedHostLaunch = {
  intent: StructuredAgentSessionLaunchIntent
  visibilityUnknown: boolean
  onVisibilityChanged?: () => void
}

function notStartedFailure(
  intent: StructuredAgentSessionLaunchIntent,
  code: string,
  message: string | undefined
): StructuredLaunchFailure | undefined {
  if (code === HOST_LAUNCH_ATTACHMENT_EXPIRED && message) {
    return { kind: 'not-started', causeText: message }
  }
  if (code === 'agent_launch_setup_not_completed') {
    return {
      kind: 'not-started',
      causeText: requiredSetupLaunchFailureText(structuredAgentLabel(intent.agent))
    }
  }
  // No terminal was planned for a chat the host cannot run, as the same create opens none.
  return code === 'agent_launch_surface_unavailable'
    ? {
        kind: 'not-started',
        causeText: structuredChatNotStartedText(structuredAgentLabel(intent.agent))
      }
    : undefined
}

/** Whether anything ran is not known. `ended`: the host said no launch remains that could take the
 *  opening, so the composer gets it back (which proves nothing about an earlier effect); else a
 *  prepared launch's opening stays whole, with its first turn, for the same launch to take. Text
 *  accept carried is possibly the host's already: a copy goes back and nothing sends it again. */
function markUnknown(state: ObservedHostLaunch, ended = false): Error {
  if (ended || state.intent.hostLaunch?.protocol !== 'release') {
    releaseHostLaunchMessage(state.intent, false)
  }
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
  releaseHostLaunchMessage(intent, hostLaunchMessageAcknowledged(intent, result))
  publishStructuredAgentSessionCreateHydration(intent, history.page, fence)
  return { sessionId: intent.sessionId, fence }
}

export async function observeStructuredHostLaunch(
  state: ObservedHostLaunch,
  hostLaunch: StructuredHostLaunch,
  throwIfCancelled: () => void
): Promise<StructuredAgentLaunchReceipt> {
  const { intent } = state
  // The held message waits with the host's Setup, not on its send's own deadline, and the launch's
  // opening is its only body.
  prepareLegacyStructuredLaunchPrompts(intent.sessionId)
  holdStructuredLaunchPromptsForLaunch(intent.sessionId)
  recordHostLaunchFirstTurnBaseline(intent)
  if (hostLaunch.accept) {
    await requireHostPermission(intent)
  }
  const answer = await awaitHostLaunchAnswer(intent, hostLaunch, throwIfCancelled, () => {
    // The host holds it now: a later read of this launch never sends accept again.
    const { accept: _held, ...accepted } = intent.hostLaunch ?? hostLaunch
    intent.hostLaunch = accepted
  })
  throwIfCancelled()
  if (answer.state === 'unread' || answer.state === 'unknown') {
    throw markUnknown(state, answer.state === 'unknown')
  }
  if (answer.state === 'failed') {
    releaseHostLaunchMessage(intent, false)
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredHostLaunchNotStartedError(
      answer.code,
      notStartedFailure(intent, answer.code, answer.message),
      answer.message
    )
  }
  const { outcome } = answer.result
  if (outcome.kind === 'terminal') {
    // A terminal existing is no receipt for the text: only the host's word on it lets it go.
    releaseHostLaunchMessage(intent, hostLaunchMessageAcknowledged(intent, answer.result))
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredHostLaunchTerminalError(answer.result)
  }
  if (outcome.sessionId !== intent.sessionId) {
    throw markUnknown(state)
  }
  return adoptHostLaunchedChat(state, answer.result)
}
