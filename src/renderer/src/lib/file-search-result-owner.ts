export type FileSearchResultOwner = {
  worktreeId: string
  runtimeEnvironmentId: string | null
  rootPath?: string
  executionHostId?: string
}

export function createFileSearchResultOwner(
  worktreeId: string,
  runtimeEnvironmentId: string | null,
  identity?: { rootPath: string; executionHostId: string }
): FileSearchResultOwner {
  return {
    ...identity,
    worktreeId,
    runtimeEnvironmentId: runtimeEnvironmentId?.trim() || null
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
