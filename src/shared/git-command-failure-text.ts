/**
 * The text a failed Git invocation left behind, for the predicates that classify a
 * failure by what Git said.
 *
 * Why all three streams and not just `message` + `stderr`: the errors Orca classifies
 * do not all come straight out of `execFile`. Node puts Git's stderr in both `message`
 * and `stderr`, but Orca also throws its own failures with the Git output on `stdout`
 * (`worktree remove`'s submodule retry attaches `git status --porcelain` output that
 * way on both the local runner and the relay). Reading all three is what keeps the
 * local and relay classifiers from disagreeing about the same error object.
 *
 * Against a real binary this reads no differently: Git emits every refusal this module
 * classifies through `error()`/`die()`, i.e. stderr only, on 2.25 through 2.55.
 */
export function readGitCommandFailureText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error)
  }
  const parts: string[] = []
  for (const field of ['message', 'stderr', 'stdout'] as const) {
    const value = (error as Record<string, unknown>)[field]
    if (typeof value === 'string' && value) {
      parts.push(value)
    }
  }
  return parts.join('\n')
}
