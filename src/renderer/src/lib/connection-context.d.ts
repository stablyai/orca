/**
 * Resolve the SSH connectionId for a worktree. Returns null for local repos,
 * the target ID string for remote repos, or undefined if the worktree/repo
 * cannot be found (e.g., store not yet hydrated).
 */
export declare function getConnectionId(worktreeId: string | null): string | null | undefined;
