import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import { createNestedRepoScanId } from '../../project-admission/dialog/add-repo-dialog-types'

export type FolderProjectGroupRefreshDependencies = Pick<
  AppState,
  'scanNestedRepos' | 'importNestedRepos' | 'moveProjectToGroup'
> & {
  getRepos: () => readonly Repo[]
}

export function canRefreshFolderProjectGroup(group: ProjectGroup | null): group is ProjectGroup {
  if (!group || group.createdFrom !== 'folder-scan' || !group.parentPath) {
    return false
  }
  const owner = parseExecutionHostId(getProjectGroupHostId(group))
  return owner?.kind === 'local' || owner?.kind === 'runtime'
}

export function getFolderProjectGroupRefreshHandler(
  group: ProjectGroup | null,
  refresh: ((group: ProjectGroup) => void) | undefined
): (() => void) | undefined {
  return canRefreshFolderProjectGroup(group) && refresh ? () => refresh(group) : undefined
}

export async function refreshFolderProjectGroup(
  group: ProjectGroup,
  dependencies: FolderProjectGroupRefreshDependencies
): Promise<void> {
  if (!canRefreshFolderProjectGroup(group) || !group.parentPath) {
    return
  }
  const owner = parseExecutionHostId(getProjectGroupHostId(group))
  if (owner?.kind !== 'local' && owner?.kind !== 'runtime') {
    return
  }
  const runtimeEnvironmentId = owner.kind === 'runtime' ? owner.environmentId : null
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
  const existingPaths = new Set(
    dependencies
      .getRepos()
      .filter((repo) => getRepoExecutionHostId(repo) === owner.id)
      .map((repo) => normalizeRuntimePathForComparison(repo.path))
  )
  const newPaths = scan.repos
    .filter((repo) => repo.depth === 1)
    .map((repo) => repo.path)
    .filter((path) => !existingPaths.has(normalizeRuntimePathForComparison(path)))
  if (newPaths.length === 0) {
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
  let movedCount = 0
  for (const entry of result.projects) {
    if (!entry.projectId) {
      continue
    }
    const repo = dependencies.getRepos().find((candidate) => candidate.id === entry.projectId)
    if (repo && (await dependencies.moveProjectToGroup(repo, group.id))) {
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
  toast.success(
    translate(
      'auto.components.sidebar.WorktreeList.projectGroupRefreshSuccess',
      'Added {{count}} projects to {{group}}',
      { count: movedCount, group: group.name }
    )
  )
}
