// Lightweight per-workspace and per-project checklists. Stored on WorktreeMeta
// (worktree scope) and Repo (project scope) so persistence writes them like
// DiffComment. `authorRole` reserves agent-authored items.

export type WorktreeTodoScope = 'worktree' | 'project'
export type WorktreeTodoAuthorRole = 'user' | 'agent'

export type WorktreeTodo = {
  id: string
  scope: WorktreeTodoScope
  /** Set when scope is 'worktree'. Owning worktree id. */
  worktreeId?: string
  /** Set when scope is 'project'. Owning repo id. */
  repoId?: string
  body: string
  /** Set when the item is checked off; cleared when re-opened. */
  completedAt?: number
  /** Manual ordering key; lower renders first. */
  order: number
  authorRole: WorktreeTodoAuthorRole
  createdAt: number
  updatedAt?: number
}
