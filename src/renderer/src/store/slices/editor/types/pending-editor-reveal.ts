export type PendingEditorReveal = {
  filePath: string
  fileId?: string
  line: number
  column: number
  matchLength: number
}

export type PendingEditorFocusRequest = {
  fileId: string
  worktreeId: string
  viewStateId: string
  expiresAt: number
  token: number
}

// Why: allow slow SSH mounts without leaving an unrelated future remount armed indefinitely.
export const EDITOR_FOCUS_REQUEST_TTL_MS = 30_000
