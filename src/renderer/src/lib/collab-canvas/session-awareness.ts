/**
 * Session-board awareness copy — one-shot inject so the live agent knows a
 * collab board is open beside its terminal. Pure text builders only.
 */

export function buildSessionBoardAwarenessText(args: {
  boardId: string
  worktreeId: string
}): string {
  const boardId = args.boardId.trim()
  const worktreeId = args.worktreeId.trim()
  return [
    '[collab-canvas awareness]',
    `A collaborative whiteboard is open beside this session.`,
    `board: ${boardId || '(unknown)'}`,
    `worktree: ${worktreeId || '(unknown)'}`,
    `Binding: session — you are the existing agent for this worktree; no second agent was spawned.`,
    `The operator can send selection digests from the board with "Send to session".`,
    `When you propose visual structure, reply so it can land as an agent-draft on the board.`,
    '--- end collab-canvas awareness ---'
  ].join('\n')
}
