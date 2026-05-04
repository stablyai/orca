// Why: per-repo fetch budget for gh CLI calls. Kept in shared/ so the renderer's
// prefetch sites (SidebarNav, ui.ts openTaskPage) and the TaskPage all use the
// same value for cache-key alignment.
export const PER_REPO_FETCH_LIMIT = 36

// Why: how many items to show after cross-repo merge. Decoupled from the per-repo
// fetch limit so changing the display cap doesn't invalidate cache keys.
export const CROSS_REPO_DISPLAY_LIMIT = 100

// Why: generic over the item shape because main-process callers emit items
// without repoId (stamped by the renderer after IPC), while renderer callers
// carry the full GitHubWorkItem. Both share only the updatedAt field needed
// here.
export function sortWorkItemsByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  })
}
