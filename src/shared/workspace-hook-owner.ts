import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { getRepoExecutionHostId, normalizeExecutionHostId } from './execution-host'

export type WorkspaceHookOwner = Pick<
  Repo,
  'id' | 'path' | 'displayName' | 'kind' | 'hookSettings' | 'connectionId' | 'executionHostId'
>

export function projectGroupHookOwner(group: ProjectGroup): WorkspaceHookOwner | null {
  return group.parentPath
    ? {
        id: projectGroupHookTrustKey(group),
        path: group.parentPath,
        displayName: group.name,
        kind: 'folder',
        hookSettings: group.hookSettings,
        connectionId: group.connectionId,
        executionHostId: getRepoExecutionHostId(group)
      }
    : null
}

const GROUP_HOOK_PREFIX = 'group-hooks:'

export function projectGroupHookTrustKey(group: ProjectGroup): string {
  return `${GROUP_HOOK_PREFIX}${JSON.stringify([getRepoExecutionHostId(group), group.id])}`
}

export function isProjectGroupHookTrustKey(key: string): boolean {
  return key.startsWith(GROUP_HOOK_PREFIX)
}

export function projectGroupHookTrustHost(
  key: string
): ReturnType<typeof normalizeExecutionHostId> {
  if (!isProjectGroupHookTrustKey(key)) {
    return null
  }
  try {
    const identity: unknown = JSON.parse(key.slice(GROUP_HOOK_PREFIX.length))
    return Array.isArray(identity) &&
      typeof identity[0] === 'string' &&
      typeof identity[1] === 'string'
      ? normalizeExecutionHostId(identity[0])
      : null
  } catch {
    return null
  }
}
