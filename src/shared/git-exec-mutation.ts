const MUTATING_GIT_EXEC_SUBCOMMANDS = new Set(['clone', 'commit', 'init'])

// Why: relay git.exec permits these narrow write shapes alongside read-only
// probes, so cache invalidation must distinguish them before dispatch.
export function gitExecMutatesRepository(args: readonly string[]): boolean {
  return MUTATING_GIT_EXEC_SUBCOMMANDS.has(args[0] ?? '')
}
