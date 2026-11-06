/** Editing a held launch's opening after its files could not reach the host: the user replaces
 *  or removes a file, keeps the rest, and saves. The same message id and launch take the edited
 *  body; nothing about the launch starts again. */

import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import type { StructuredHostLaunch } from './structured-agent-session-host-launch'
import {
  resumeHostLaunchPreparation,
  saveHostLaunchFirstTurn
} from './structured-agent-session-host-launch-release'
import { getStructuredLaunchStateBySessionId } from './structured-agent-session-launch-registry'

type FirstMessageBody = StructuredAgentSessionFirstMessage['body']

/** A complete replacement for a held launch's opening, as the user edited it: its client body and
 *  the files the host must still receive, with how to put them there under the launch. */
export type HeldHostLaunchOpeningEdit = {
  body: FirstMessageBody
  staged?: {
    paths: readonly string[]
    prepare: NonNullable<StructuredHostLaunch['prepareFirstMessage']>
  }
}

/** The opening of a held launch whose files could not reach its host, while its first turn is
 *  still being edited: what an edit starts from, and the client files it still owes the host. */
export function editableHostLaunchOpening(
  worktreeId: string,
  sessionId: string
): { opening: StructuredAgentSessionFirstMessage; staged: readonly string[] } | undefined {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const firstTurn = state?.intent.hostLaunch?.firstTurn
  if (
    !state?.parkedFailure ||
    state.cancelled ||
    state.intent.worktreeId !== worktreeId ||
    !state.intent.opening ||
    firstTurn?.phase !== 'editing'
  ) {
    return undefined
  }
  return { opening: state.intent.opening, staged: firstTurn.staged ?? [] }
}

/** Replaces the opening of a held launch whose first turn is still being edited, under the same
 *  message id and launch: body, files still owed and their preparation change together in one
 *  saved write, then a preparation that could not finish runs again with them. A submitted first
 *  turn is the exact input already sent and is never edited. */
export function replaceHeldHostLaunchOpening(
  worktreeId: string,
  sessionId: string,
  edit: HeldHostLaunchOpeningEdit
): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const intent = state?.intent
  const hostLaunch = intent?.hostLaunch
  const firstTurn = hostLaunch?.firstTurn
  if (
    !state ||
    !intent?.opening ||
    intent.worktreeId !== worktreeId ||
    state.cancelled ||
    hostLaunch?.protocol !== 'release' ||
    firstTurn?.phase !== 'editing'
  ) {
    return false
  }
  const { staged: _owed, ...choices } = firstTurn
  const { stagedSources: _held, prepareFirstMessage: _preparing, ...launch } = hostLaunch
  const paths = edit.staged?.paths.length ? [...edit.staged.paths] : undefined
  intent.hostLaunch = {
    ...launch,
    ...(paths && edit.staged
      ? { stagedSources: paths, prepareFirstMessage: edit.staged.prepare }
      : {})
  }
  saveHostLaunchFirstTurn(
    intent,
    { ...choices, ...(paths ? { staged: paths } : {}) },
    { clientMessageId: intent.opening.clientMessageId, body: edit.body }
  )
  resumeHostLaunchPreparation(worktreeId, sessionId)
  return true
}
