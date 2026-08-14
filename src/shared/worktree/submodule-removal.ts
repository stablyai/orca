function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    for (const field of ['message', 'stderr', 'stdout'] as const) {
      const value = (error as Record<string, unknown>)[field]
      if (typeof value === 'string' && value) {
        parts.push(value)
      }
    }
    return parts.join('\n')
  }
  return String(error)
}

// Why: `git worktree remove` (non-force) categorically refuses any worktree
// containing an initialised submodule, even when parent and submodule are
// fully clean (validate_no_submodules, Git >= 2.17). Callers re-prove
// cleanliness and retry with --force. Both the local runner and the relay pin
// English git output (UNTRANSLATED_GIT_OUTPUT_ENV), so text matching is stable.
export function isSubmoduleWorktreeRemovalRefusal(error: unknown): boolean {
  return /working trees containing submodules cannot be moved or removed/i.test(getErrorText(error))
}
