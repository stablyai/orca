/** Editing a held launch's opening after its files could not reach the host: the user replaces
 *  or removes a file, keeps the rest, and saves. The same message id and launch take the edited
 *  body; nothing about the launch starts again. */

import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import {
  hostLaunchOpeningInput,
  type HostLaunchSources
} from './structured-agent-session-host-launch-sources'
import { showHeldStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
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
  /** Its own lease on them, which the launch owns from a successful replacement on. */
  staged?: { paths: readonly string[]; sources: HostLaunchSources }
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
  const { stagedSources: _held, sources: replaced, ...launch } = hostLaunch
  const paths = edit.staged?.paths.length ? [...edit.staged.paths] : undefined
  intent.hostLaunch = {
    ...launch,
    ...(paths ? { stagedSources: paths } : {}),
    ...(edit.staged ? { sources: edit.staged.sources } : {})
  }
  saveHostLaunchFirstTurn(
    intent,
    { ...choices, ...(paths ? { staged: paths } : {}) },
    { clientMessageId: intent.opening.clientMessageId, body: edit.body }
  )
  // The new files are held before the old ones go; an upload of the old ones still on its way
  // finds them released and is prepared again from the edited opening.
  replaced?.release()
  showHeldStructuredLaunchPrompt(sessionId, hostLaunchOpeningInput(edit.body))
  resumeHostLaunchPreparation(worktreeId, sessionId)
  return true
}
