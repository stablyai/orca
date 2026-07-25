/**
 * Session-board inject into the worktree's live terminal agent.
 * Does NOT spawn a second omp session (session boards borrow the terminal).
 */
import type { PasteTerminalTextDetail } from '@/constants/terminal'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'
import type { CollabCanvasInjectPayload } from './collab-canvas-bridge'
import { buildSessionBoardAwarenessText } from './session-awareness'

export type SessionInjectResult =
  | { ok: true; usesExistingSessionAgent: true; tabId: string }
  | { ok: false; reason: string }

export type SessionInjectDispatch = (event: Event) => void

/**
 * Dispatch the bridge payload into a specific terminal tab via the same paste
 * event path operator tools use. Requires tabId — the live paste handler
 * matches on PasteTerminalTextDetail.tabId only.
 */
export function injectCollabPayloadIntoTerminal(
  payload: CollabCanvasInjectPayload,
  options: {
    tabId: string
    dispatch?: SessionInjectDispatch
  }
): SessionInjectResult {
  if (payload.kind !== 'collab-canvas-inject') {
    return { ok: false, reason: 'not-collab-inject' }
  }
  if (!payload.usesExistingSessionAgent) {
    return { ok: false, reason: 'must-use-existing-session-agent' }
  }
  const tabId = options.tabId.trim()
  if (!tabId) {
    return { ok: false, reason: 'missing-terminal-tab' }
  }
  const detail: PasteTerminalTextDetail & {
    worktreeId?: string
    boardId?: string
    atlasDataUri?: string | null
  } = {
    tabId,
    text: payload.terminalText,
    worktreeId: payload.worktreeId,
    boardId: payload.boardId,
    atlasDataUri: payload.atlasDataUri
  }
  const dispatch = options.dispatch ?? ((e) => window.dispatchEvent(e))
  dispatch(new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail }))
  return { ok: true, usesExistingSessionAgent: true, tabId }
}

/** One-shot awareness note into the session agent terminal. */
export function injectSessionBoardAwareness(args: {
  boardId: string
  worktreeId: string
  tabId: string
  dispatch?: SessionInjectDispatch
}): SessionInjectResult {
  const tabId = args.tabId.trim()
  if (!tabId) {
    return { ok: false, reason: 'missing-terminal-tab' }
  }
  const detail: PasteTerminalTextDetail = {
    tabId,
    text: buildSessionBoardAwarenessText({
      boardId: args.boardId,
      worktreeId: args.worktreeId
    })
  }
  const dispatch = args.dispatch ?? ((e) => window.dispatchEvent(e))
  dispatch(new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail }))
  return { ok: true, usesExistingSessionAgent: true, tabId }
}
