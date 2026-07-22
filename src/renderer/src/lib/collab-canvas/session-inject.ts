/**
 * Session-board inject into the worktree's live terminal agent.
 * Does NOT spawn a second omp session (session boards borrow the terminal).
 */
import type { CollabCanvasInjectPayload } from './collab-canvas-bridge'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'

export type SessionInjectResult =
  | { ok: true; usesExistingSessionAgent: true }
  | { ok: false; reason: string }

/**
 * Dispatch the bridge payload into the active terminal via the same paste
 * event path operator tools use. Pure side-effect wrapper for dogfood/tests.
 */
export function injectCollabPayloadIntoTerminal(
  payload: CollabCanvasInjectPayload,
  dispatch: (event: Event) => void = (e) => window.dispatchEvent(e)
): SessionInjectResult {
  if (payload.kind !== 'collab-canvas-inject') {
    return { ok: false, reason: 'not-collab-inject' }
  }
  if (!payload.usesExistingSessionAgent) {
    return { ok: false, reason: 'must-use-existing-session-agent' }
  }
  const detail = {
    text: payload.terminalText,
    worktreeId: payload.worktreeId,
    boardId: payload.boardId,
    atlasDataUri: payload.atlasDataUri
  }
  dispatch(new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail }))
  return { ok: true, usesExistingSessionAgent: true }
}
