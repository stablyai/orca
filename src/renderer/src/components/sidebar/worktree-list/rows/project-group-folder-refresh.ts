import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../../../shared/cross-platform-path'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getProjectGroupHostId } from '@/store/project-groups/project-group-owner-routing'
import { createNestedRepoScanId } from '../../project-admission/dialog/add-repo-dialog-types'

export type FolderProjectGroupRefreshDependencies = Pick<
  AppState,
  'scanNestedRepos' | 'importNestedRepos' | 'moveProjectToGroup'
> & {
  getRepos: () => readonly Repo[]
  getProjectGroups: () => readonly ProjectGroup[]
}

function getRefreshOwner(
  group: ProjectGroup | null
): { id: string; runtimeEnvironmentId: string | null } | null {
  if (!group || group.createdFrom !== 'folder-scan' || !group.parentPath) {
    return null
  }
  const hostId = getProjectGroupHostId(group)
  const owner = parseExecutionHostId(hostId)
  if (owner?.kind === 'local') {
    return { id: hostId, runtimeEnvironmentId: null }
  }
  if (owner?.kind === 'runtime') {
    return { id: hostId, runtimeEnvironmentId: owner.environmentId }
  }
  return null
}

export function canRefreshFolderProjectGroup(group: ProjectGroup | null): group is ProjectGroup {
  return getRefreshOwner(group) !== null
}

export function getFolderProjectGroupRefreshHandler(
  group: ProjectGroup | null,
  refresh: ((group: ProjectGroup) => void) | undefined
): (() => void) | undefined {
  return canRefreshFolderProjectGroup(group) && refresh ? () => refresh(group) : undefined
}

/**
 * Why: group-mode imports split deeper repos into folder-scope sub-groups, so a
 * newly found repo belongs in the deepest folder-scan group (this one or a
 * descendant on the same host) whose folder contains it.
 */
function createTargetGroupResolver(
  root: ProjectGroup,
  ownerId: string,
  groups: readonly ProjectGroup[]
): (repoPath: string) => ProjectGroup {
  const sameHostGroups = groups.filter((candidate) => getProjectGroupHostId(candidate) === ownerId)
  const byId = new Map(sameHostGroups.map((candidate) => [candidate.id, candidate]))
  const isWithinRoot = (candidate: ProjectGroup): boolean => {
    const seen = new Set<string>()
    let current: ProjectGroup | undefined = candidate
    while (current && !seen.has(current.id)) {
      if (current.id === root.id) {
        return true
      }
      seen.add(current.id)
      current = current.parentGroupId ? byId.get(current.parentGroupId) : undefined
    }
    return false
  }
  const scopes = sameHostGroups
    .filter(
      (candidate) =>
        candidate.id !== root.id &&
        candidate.createdFrom === 'folder-scan' &&
        candidate.parentPath &&
        isWithinRoot(candidate)
    )
    .sort((left, right) => (right.parentPath?.length ?? 0) - (left.parentPath?.length ?? 0))
  return (repoPath) =>
    scopes.find((scope) => scope.parentPath && isPathInsideOrEqual(scope.parentPath, repoPath)) ??
    root
}

export async function refreshFolderProjectGroup(
  group: ProjectGroup,
  dependencies: FolderProjectGroupRefreshDependencies
): Promise<void> {
  const owner = getRefreshOwner(group)
  if (!owner || !group.parentPath) {
    return
  }
  const { runtimeEnvironmentId } = owner
  const scanId = createNestedRepoScanId()
  const scan = await dependencies.scanNestedRepos(group.parentPath, undefined, {
    scanId,
    runtimeEnvironmentId
  })
  if (!scan || scan.selectedPathKind !== 'non_git_folder') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeList.projectGroupRefreshScanFailed',
        'Could not scan this project group'
      )
    )
    return
  }
  // Why: a cut-short scan can miss repos, so "nothing new" would be misleading.
  const scanIncomplete = scan.truncated || scan.timedOut || scan.stopped
  const ownedRepos = (): Repo[] =>
    dependencies.getRepos().filter((repo) => getRepoExecutionHostId(repo) === owner.id)
  const existingPaths = new Set(
    ownedRepos().map((repo) => normalizeRuntimePathForComparison(repo.path))
  )
  const newPaths = scan.repos
    .map((repo) => repo.path)
    .filter((path) => !existingPaths.has(normalizeRuntimePathForComparison(path)))
  if (newPaths.length === 0) {
    if (scanIncomplete) {
      toast.warning(
        translate(
          'auto.components.sidebar.WorktreeList.projectGroupRefreshIncomplete',
          'The folder scan stopped early; some new projects may not have been found'
        )
      )
      return
    }
    toast.info(
      translate(
        'auto.components.sidebar.WorktreeList.projectGroupRefreshNoProjects',
        'No new projects found'
      )
    )
    return
  }
  const result = await dependencies.importNestedRepos({
    parentPath: scan.selectedPath,
    groupName: group.name,
    projectPaths: newPaths,
    scanId,
    runtimeEnvironmentId,
    mode: 'separate'
  })
  if (!result) {
    return
  }
  const resolveTargetGroup = createTargetGroupResolver(
    group,
    owner.id,
    dependencies.getProjectGroups()
  )
  let movedCount = 0
  for (const entry of result.projects) {
    if (!entry.projectId) {
      continue
    }
    const repo = ownedRepos().find((candidate) => candidate.id === entry.projectId)
    if (repo && (await dependencies.moveProjectToGroup(repo, resolveTargetGroup(repo.path).id))) {
      movedCount++
    }
  }
  if (result.failedCount > 0 || movedCount < result.importedCount + result.alreadyKnownCount) {
    toast.warning(
      translate(
        'auto.components.sidebar.WorktreeList.projectGroupRefreshPartial',
        'Some new projects could not be added to the group'
      )
    )
    return
  }
  const successMessage = translate(
    'auto.components.sidebar.WorktreeList.projectGroupRefreshSuccess',
    'Added {{count}} projects to {{group}}',
    {
      count: movedCount,
      group: group.name,
      defaultValue_one: 'Added {{count}} project to {{group}}'
    }
  )
  if (scanIncomplete) {
    toast.warning(successMessage, {
      description: translate(
        'auto.components.sidebar.WorktreeList.projectGroupRefreshIncomplete',
        'The folder scan stopped early; some new projects may not have been found'
      )
    })
    return
  }
  toast.success(successMessage)
}
