/** A host launch prepared before its workspace's Setup finished takes its first turn's final input
 *  only once the host says Setup succeeded. Until then the chat's picker edits that first turn and
 *  its held message keeps its client files. The window first puts those files on the host under the
 *  launch, then reads the picks in one synchronous step, saves them with the host-readable message
 *  as submitted and sends them, so every pick made before that step governs the first turn and any
 *  later one is a next-turn choice. A lost reply sends the same saved input again; nothing is ever
 *  prepared or read twice. */

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  restoredHostLaunchSources,
  retireHostLaunchSources
} from './structured-agent-session-host-launch-sources'
import {
  currentHostLaunchObserver,
  type HostLaunchObserver
} from './structured-agent-session-host-launch-observer'
import { nativeChatAttachFailedNotice } from '@/components/native-chat/native-chat-attachment-upload'
import { translate } from '@/i18n/i18n'
import { joinSentences } from '../../../../../shared/sentence-joining'
import { structuredAgentLabel } from './structured-agent-session-launch-label'
import type {
  AgentLaunchReleaseParams,
  AgentLaunchReleaseResult
} from '../../../../../shared/rpc-contract/agent-launch-release-params'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import { captureStructuredLaunchFirstTurn } from './structured-agent-session-launch-create-message'
import type { HostLaunchFirstTurn } from './structured-agent-session-launch-record'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchIntentChanged,
  publishStructuredLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

type ReleasedChoices = Omit<Extract<HostLaunchFirstTurn, { phase: 'submitted' }>, 'phase'>

/** The held message's files could not reach the host (a source gone, a host refusing the upload):
 *  nothing is released and nothing is given back. The input stays held and saved as it was, under
 *  the same live launch, until `resumed` (an explicit Retry) prepares it again. */
export class HostLaunchInputUnavailableError extends Error {
  constructor(
    message: string,
    readonly resumed: Promise<void>
  ) {
    super(message)
    this.name = 'HostLaunchInputUnavailableError'
  }
}

/** An explicit Retry of a held launch whose message's files could not reach its host: its current
 *  observation prepares them again, under the same launch. */
export function resumeHostLaunchPreparation(worktreeId: string, sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const observer = currentHostLaunchObserver(sessionId)
  const resume = observer?.resume
  if (state?.intent.worktreeId !== worktreeId || state.cancelled || !observer || !resume) {
    return false
  }
  delete observer.resume
  forgetParkedHostLaunchFailure(state.intent)
  resume()
  return true
}

/** Clears the shown parked failure unless a newer observation of the launch is parked itself. */
export function forgetParkedHostLaunchFailure(intent: StructuredAgentSessionLaunchIntent): void {
  const state = getStructuredLaunchStateBySessionId(intent.sessionId)
  if (
    state?.intent === intent &&
    state.parkedFailure &&
    !currentHostLaunchObserver(intent.sessionId)?.resume
  ) {
    delete state.parkedFailure
    publishStructuredLaunchStatus()
  }
}

/** Shows the launch as not started, with the existing Retry, naming the files that were not sent. */
function parkPreparation(
  intent: StructuredAgentSessionLaunchIntent,
  staged: readonly string[],
  cause: string
): Promise<void> {
  const resumed = Promise.withResolvers<void>()
  const observer = currentHostLaunchObserver(intent.sessionId)
  if (observer) {
    observer.resume = resumed.resolve
  }
  const state = getStructuredLaunchStateBySessionId(intent.sessionId)
  if (state?.intent === intent) {
    const names = staged.map((path) => path.split(/[\\/]/).findLast(Boolean) ?? path)
    state.parkedFailure = {
      kind: 'not-started',
      causeText: joinSentences([
        translate(
          'auto.components.terminal.pane.AgentLaunchPaneNotice.notStarted',
          "{{agent}} couldn't start.",
          {
            agent: structuredAgentLabel(intent.agent)
          }
        ),
        nativeChatAttachFailedNotice(names, cause)
      ])
    }
    publishStructuredLaunchStatus()
  }
  return resumed.promise
}

/** The launch this window still holds for the intent; any other has been retired or replaced, and
 *  its own cancellation check ends the read. */
function heldLaunchState(
  intent: StructuredAgentSessionLaunchIntent,
  observer: HostLaunchObserver
): StructuredLaunchState {
  const state = getStructuredLaunchStateBySessionId(intent.sessionId)
  if (!state || state.intent !== intent || state.cancelled || observer.signal.aborted) {
    throw new Error('host launch no longer held')
  }
  return state
}

/** The chat's picks as its first turn would carry them. The host takes a per-message selection
 *  and explicit options, so selection is always present, empty included: its absence must never
 *  let the host bring back a remembered model or effort. */
function readFirstTurn(state: StructuredLaunchState, freeze: boolean): ReleasedChoices {
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

/** Saved with the launch's own row and shown, in one write: a failed save never holds it back. */
export function saveHostLaunchFirstTurn(
  intent: StructuredAgentSessionLaunchIntent,
  firstTurn: HostLaunchFirstTurn,
  opening?: StructuredAgentSessionFirstMessage
): void {
  if (intent.hostLaunch) {
    intent.hostLaunch = { ...intent.hostLaunch, firstTurn }
  }
  if (opening) {
    intent.opening = opening
  }
  notifyStructuredLaunchIntentChanged(intent)
}

/** Saves the choices the chat shows as the launch starts, and the files its message still needs on
 *  the host, so a reload can still finish them. */
export function recordHostLaunchFirstTurnBaseline(
  intent: StructuredAgentSessionLaunchIntent
): void {
  const state = getStructuredLaunchStateBySessionId(intent.sessionId)
  const hostLaunch = intent.hostLaunch
  if (hostLaunch?.protocol !== 'release' || hostLaunch.firstTurn || state?.intent !== intent) {
    return
  }
  const staged = intent.opening ? hostLaunch.stagedSources : undefined
  saveHostLaunchFirstTurn(intent, {
    phase: 'editing',
    ...readFirstTurn(state, false),
    ...(staged?.length ? { staged: [...staged] } : {})
  })
}

/** The held message as the host reads it: its client files uploaded under this launch and every
 *  reference rewritten to the host's paths. One already host-readable is returned as it is. */
async function hostReadableFirstMessage(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string
): Promise<StructuredAgentSessionFirstMessage | undefined> {
  const hostLaunch = intent.hostLaunch
  const message = intent.opening
  const firstTurn = hostLaunch?.firstTurn
  const staged = firstTurn?.phase === 'editing' ? firstTurn.staged : undefined
  if (!hostLaunch || !message || !staged?.length) {
    return message
  }
  // A reloaded launch holds its files again only by the paths its record listed.
  const sources = (hostLaunch.sources ??= restoredHostLaunchSources(
    intent.sessionId,
    staged,
    message.body
  ))
  try {
    const body = await sources.prepare(message.body, operationId, intent.target)
    return { clientMessageId: message.clientMessageId, body }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new HostLaunchInputUnavailableError(cause, parkPreparation(intent, staged, cause))
  }
}

/** Hands the host its first turn: the input already submitted, unchanged, or else the prepared
 *  message with the chat's picks of now. After the files are on the host, reading, saving and
 *  sending happen in one synchronous step. */
export async function releaseHostLaunchFirstTurn(
  intent: StructuredAgentSessionLaunchIntent,
  operationId: string,
  observer: HostLaunchObserver
): Promise<AgentLaunchReleaseResult> {
  let firstTurn = intent.hostLaunch?.firstTurn
  if (!firstTurn) {
    // Nothing says what this turn runs with; no default stands in for it.
    throw new Error('host launch first turn unavailable')
  }
  if (firstTurn.phase !== 'submitted') {
    let firstMessage: StructuredAgentSessionFirstMessage | undefined
    let preparedFrom: StructuredAgentSessionFirstMessage | undefined
    // An opening edited while its files were on their way is prepared again; the obsolete one is
    // never released.
    do {
      heldLaunchState(intent, observer)
      preparedFrom = intent.opening
      try {
        firstMessage = await hostReadableFirstMessage(intent, operationId)
      } catch (error) {
        if (intent.opening === preparedFrom) {
          throw error
        }
      }
    } while (intent.opening !== preparedFrom)
    // No await from here to the request: a pick processed during the upload governs this turn.
    firstTurn = { phase: 'submitted', ...readFirstTurn(heldLaunchState(intent, observer), true) }
    saveHostLaunchFirstTurn(intent, firstTurn, firstMessage)
    // Host-readable now and never prepared again: its client files are no longer needed.
    retireHostLaunchSources(intent)
  }
  const { phase: _submitted, ...choices } = firstTurn
  const message = intent.opening
  const params: AgentLaunchReleaseParams = {
    operationId,
    ...choices,
    ...(message
      ? { firstMessage: { clientMessageId: message.clientMessageId, body: message.body } }
      : {})
  }
  return callRuntimeRpc<AgentLaunchReleaseResult>(intent.target, 'agent.launchRelease', params)
}
