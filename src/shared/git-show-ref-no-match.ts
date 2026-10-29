/** True when `git show-ref --verify --quiet` proved the ref absent, as opposed to the probe itself failing. */
export function isShowRefNoMatchError(error: unknown): boolean {
  // Only numeric exit 1 proves absence; string transport codes (even "1") remain unknown.
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 1) {
    return false
  }
  // --quiet absence has empty stderr; wrappers exiting 1 with diagnostics may never have run Git.
  // Missing stderr preserves the SSH provider’s exit-code-only contract.
  const stderr = 'stderr' in error ? error.stderr : undefined
  return stderr === undefined || stderr === null || String(stderr).trim().length === 0
}
