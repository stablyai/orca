/** True when `git show-ref --verify --quiet` proved the ref absent, as opposed to the probe itself failing. */
export function isShowRefNoMatchError(error: unknown): boolean {
  // Git reports a missing ref as numeric exit status 1. Keep string-valued
  // transport/error codes (including a relay that happens to use `"1"`) in
  // the unknown bucket so SSH loss cannot look like an absent ref.
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 1) {
    return false
  }
  // `--quiet` makes Git print nothing for a missing ref, but a wrapper that
  // also exits 1 always explains itself: `wsl.exe` on a dead distro, a relay
  // transport error. Empty stderr is what separates proven absence from a
  // probe that never ran. A runner that reports no stderr at all (the SSH
  // provider) keeps its existing exit-code contract.
  const stderr = 'stderr' in error ? error.stderr : undefined
  return stderr === undefined || stderr === null || String(stderr).trim().length === 0
}
