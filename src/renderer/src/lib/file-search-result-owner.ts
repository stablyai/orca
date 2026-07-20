import type { GlobalSettings } from '../../../shared/types'

export type FileSearchResultOwner = {
  worktreeId: string
  runtimeEnvironmentId: string | null
}

export function createFileSearchResultOwner(
  worktreeId: string,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
): FileSearchResultOwner {
  return {
    worktreeId,
    runtimeEnvironmentId: settings.activeRuntimeEnvironmentId?.trim() || null
  }
}
