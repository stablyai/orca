export type EditorFileDropDestination = {
  worktreeId: string
  /** When omitted, the store chooses this workspace's default editor destination. */
  groupId?: string
}
