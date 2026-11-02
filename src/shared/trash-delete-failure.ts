export const TRASH_DELETE_FAILED_MESSAGE = 'Failed to move item to the Trash'

// Electron IPC prefixes remote errors, so match by substring.
export function isTrashDeleteFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TRASH_DELETE_FAILED_MESSAGE)
}
