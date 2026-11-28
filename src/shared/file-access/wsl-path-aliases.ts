import { parseWslUncPath, toWindowsWslPath } from './wsl-paths'
import { normalizeRuntimePathForComparison } from './cross-platform-path'

/** Require caller UNC cwd to prove the distro: Linux tails repeat across distros, and a tail-only match could make worktree rm delete another distro’s directory. */
export function isWslUncPathForCallerLinuxPath(
  uncPath: string,
  linuxPath: string,
  callerDistro: string
): boolean {
  const parsed = parseWslUncPath(uncPath)
  if (!parsed) {
    return false
  }
  // Why the case split: Windows folds the distro name, the Linux tail it fronts is case-sensitive.
  return (
    parsed.distro.toLowerCase() === callerDistro.toLowerCase() &&
    normalizeRuntimePathForComparison(parsed.linuxPath) ===
      normalizeRuntimePathForComparison(linuxPath)
  )
}

/** Windows-backed /mnt/<drive> paths are shared across distros, so they need no caller-distro proof. */
export function isWslUncPathForLinuxMountedPath(uncPath: string, linuxPath: string): boolean {
  const parsed = parseWslUncPath(uncPath)
  if (!parsed || !/^\/mnt\/[A-Za-z](?:\/|$)/.test(parsed.linuxPath)) {
    return false
  }
  if (!/^\/mnt\/[A-Za-z](?:\/|$)/.test(linuxPath)) {
    return false
  }
  return (
    normalizeRuntimePathForComparison(toWindowsWslPath(parsed.linuxPath, parsed.distro)) ===
    normalizeRuntimePathForComparison(toWindowsWslPath(linuxPath, parsed.distro))
  )
}

export function areLocalWindowsWslPathAliases(left: string, right: string): boolean {
  const leftIdentity = getLocalWindowsWslPathIdentity(left)
  const rightIdentity = getLocalWindowsWslPathIdentity(right)
  return (
    (leftIdentity.isWslUnc || rightIdentity.isWslUnc) &&
    leftIdentity.aliasComparisonPath === rightIdentity.aliasComparisonPath
  )
}

export type LocalWindowsWslPathIdentity = {
  normalizedPath: string
  aliasComparisonPath: string
  isWslUnc: boolean
}

export function getLocalWindowsWslPathIdentity(value: string): LocalWindowsWslPathIdentity {
  const wslPath = parseWslUncPath(value)
  const normalizedPath = normalizeRuntimePathForComparison(value)
  return {
    normalizedPath,
    aliasComparisonPath: wslPath
      ? normalizeRuntimePathForComparison(toWindowsWslPath(wslPath.linuxPath, wslPath.distro))
      : normalizedPath,
    isWslUnc: wslPath !== null
  }
}
