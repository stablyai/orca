const MUTATING_GIT_EXEC_SUBCOMMANDS = new Set(['clone', 'commit', 'init'])
// Why: `git remote` also serves the bare list and get-url reads, so only the
// permitted fork-remote writes may invalidate cached reads.
const MUTATING_GIT_REMOTE_ACTIONS = new Set(['add', 'remove'])

// Why: relay git.exec permits these narrow write shapes alongside read-only
// probes, so cache invalidation must distinguish them before dispatch.
export function gitExecMutatesRepository(args: readonly string[]): boolean {
  if (args[0] === 'remote') {
    return MUTATING_GIT_REMOTE_ACTIONS.has(args[1] ?? '')
  }
  return MUTATING_GIT_EXEC_SUBCOMMANDS.has(args[0] ?? '')
}
