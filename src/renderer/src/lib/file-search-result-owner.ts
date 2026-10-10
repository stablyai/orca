import type { GlobalSettings } from '../../../shared/global-settings-types'

export type FileSearchResultOwner = {
  worktreeId: string
  runtimeEnvironmentId: string | null
  rootPath?: string
  executionHostId?: string
}

export function createFileSearchResultOwner(
  worktreeId: string,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>,
  identity?: { rootPath: string; executionHostId: string }
): FileSearchResultOwner {
  return {
    ...identity,
    worktreeId,
    runtimeEnvironmentId: settings.activeRuntimeEnvironmentId?.trim() || null
  }
}

export function isFileSearchResultOwnerCurrent(
  owner: FileSearchResultOwner | null | undefined,
  worktreeId: string | null,
  rootPath: string | null,
  runtimeEnvironmentId: string | null,
  executionHostId: string
): boolean {
  return Boolean(
    owner &&
    owner.worktreeId === worktreeId &&
    owner.rootPath === rootPath &&
    owner.runtimeEnvironmentId === runtimeEnvironmentId &&
    owner.executionHostId === executionHostId
  )
}
