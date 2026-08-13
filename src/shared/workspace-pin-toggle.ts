export type WorkspacePinToggleTarget = {
  worktreeId: string
  nextPinned: boolean
}

/** Resolve pin toggle for the focused workspace; null when there is nothing to toggle. */
export function resolveWorkspacePinToggleTarget(input: {
  worktreeId: string | null | undefined
  isPinned: boolean | null | undefined
}): WorkspacePinToggleTarget | null {
  if (!input.worktreeId || typeof input.isPinned !== 'boolean') {
    return null
  }
  return { worktreeId: input.worktreeId, nextPinned: !input.isPinned }
}
