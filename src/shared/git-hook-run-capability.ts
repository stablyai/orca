/** `git hook run` arrived in Git 2.36; older Git rejects the whole subcommand. */
export function isHookRunUnsupportedError(error: unknown): boolean {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined
  const message = error instanceof Error ? error.message : ''
  return /'hook' is not a git command/.test(
    `${typeof stderr === 'string' ? stderr : ''}\n${message}`
  )
}
