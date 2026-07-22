/**
 * Session-board awareness copy — one-shot inject so the live agent knows a
 * collab board is open beside its terminal. Pure text builders only.
 *
 * Framed as a short operator note (not a `[system]` / MCP-style notice) so
 * models do not file it next to tool-availability pings.
 */

export function buildSessionBoardAwarenessText(args: {
  boardId: string
  worktreeId: string
}): string {
  const boardId = args.boardId.trim()
  const worktreeId = args.worktreeId.trim()
  return [
    '',
    'OPERATOR — collab board is open beside this terminal.',
    `Board id: ${boardId || '(unknown)'} · worktree: ${worktreeId || '(unknown)'}.`,
    'You are the existing session agent (no second agent).',
    'I may send sketches from the board with "Send to session" — treat those as real operator asks about the drawing.',
    'When you propose layout or UI structure, keep replies short so I can place them as agent-drafts on the board.',
    ''
  ].join('\n')
}
