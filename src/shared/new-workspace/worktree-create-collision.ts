export const WORKTREE_CREATE_COLLISION_CODE = 'worktree_create_collision' as const

// Marks an exhausted name search before any workspace was created.
export class WorktreeCreateCollisionError extends Error {}
