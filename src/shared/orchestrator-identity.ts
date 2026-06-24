// Why: a director worktree is created with this displayName prefix. It is the
// durable, restart-surviving marker of an Orcastrator/director shell, shared so
// the renderer (sidebar + reattach) and the CLI/main create path (worker
// focus-steal suppression) identify directors the exact same way.
export const ORCASTRATOR_DISPLAY_PREFIX = 'Orcastrator · '

export function isOrchestratorDisplayName(displayName: string | undefined | null): boolean {
  return typeof displayName === 'string' && displayName.startsWith(ORCASTRATOR_DISPLAY_PREFIX)
}
