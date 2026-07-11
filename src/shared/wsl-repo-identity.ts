import { parseWslUncPath } from './wsl-paths'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'

export function getRepoDisplayPath(path: string): string {
  return parseWslUncPath(path)?.linuxPath ?? path
}
export function isWslRuntimeResolution(
  resolution: ProjectExecutionRuntimeResolution | undefined
): boolean {
  return resolution?.status === 'resolved' && resolution.runtime.kind === 'wsl'
}
