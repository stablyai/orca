import { parseWslUncPath } from './wsl-paths'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'

/** Display path for a repo: the POSIX form for WSL UNC paths, otherwise the path unchanged. */
export function getRepoDisplayPath(path: string): string {
  return parseWslUncPath(path)?.linuxPath ?? path
}

/** True when the runtime resolved to a WSL distro (as opposed to windows-host or repair-required). */
export function isWslRuntimeResolution(
  resolution: ProjectExecutionRuntimeResolution | undefined
): boolean {
  return resolution?.status === 'resolved' && resolution.runtime.kind === 'wsl'
}

/** Distro for a resolved WSL runtime, or null when not on WSL (see isWslRuntimeResolution). */
export function getWslRuntimeDistro(
  resolution: ProjectExecutionRuntimeResolution | undefined
): string | null {
  if (!isWslRuntimeResolution(resolution)) {
    return null
  }
  // Why: isWslRuntimeResolution is a boolean predicate; re-check the
  // discriminated union so TS narrows `resolution.runtime` to the wsl arm.
  return resolution?.status === 'resolved' && resolution.runtime.kind === 'wsl'
    ? resolution.runtime.distro
    : null
}
