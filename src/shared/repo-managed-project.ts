import { normalizeRuntimePathForComparison } from './cross-platform-path'
import type { FolderWorkspace } from './folder-workspace-types'
import type { NestedRepoScanResult, ProjectGroup, ProjectGroupCreatedFrom } from './project-group-types'

export const REPO_MANAGED_CREATED_FROM = 'repo-managed' satisfies ProjectGroupCreatedFrom
export const REPO_MANAGED_SCAN_KIND = 'repo_managed' satisfies NestedRepoScanResult['selectedPathKind']

export const REPO_METADATA_DIR = '.repo'
export const REPO_MANAGED_MARKERS = ['manifest.xml', 'project.list'] as const

const FOLDER_BACKED_CREATED_FROM = new Set<ProjectGroupCreatedFrom>([
  'folder-scan',
  'repo-managed'
])

export function isRepoManagedCreatedFrom(
  createdFrom: ProjectGroup['createdFrom'] | null | undefined
): boolean {
  return createdFrom === REPO_MANAGED_CREATED_FROM
}

export function isRepoManagedProjectGroup(
  group: Pick<ProjectGroup, 'createdFrom'> | null | undefined
): boolean {
  return isRepoManagedCreatedFrom(group?.createdFrom)
}

export function isRepoManagedScan<T extends Pick<NestedRepoScanResult, 'selectedPathKind'>>(
  scan: T | null | undefined
): scan is T & { selectedPathKind: 'repo_managed' } {
  return scan?.selectedPathKind === REPO_MANAGED_SCAN_KIND
}

export function isFolderBackedProjectGroup(
  group: Pick<ProjectGroup, 'createdFrom' | 'parentPath'> | null | undefined
): boolean {
  return Boolean(group?.parentPath?.trim()) && FOLDER_BACKED_CREATED_FROM.has(group!.createdFrom)
}

export function findMainFolderWorkspace(
  workspaces: readonly FolderWorkspace[],
  group: Pick<ProjectGroup, 'id' | 'parentPath'>
): FolderWorkspace | undefined {
  const parentPath = group.parentPath?.trim()
  if (!parentPath) {
    return undefined
  }
  const parentKey = normalizeRuntimePathForComparison(parentPath)
  return workspaces.find(
    (workspace) =>
      workspace.projectGroupId === group.id &&
      normalizeRuntimePathForComparison(workspace.folderPath) === parentKey
  )
}

export type FolderWorkspaceCreateIntent =
  | { kind: 'activate-main'; workspace: FolderWorkspace }
  | { kind: 'create-main' }
  | { kind: 'derive' }
  | { kind: 'create-folder' }

export function resolveFolderWorkspaceCreateIntent(args: {
  group: Pick<ProjectGroup, 'id' | 'parentPath' | 'createdFrom'>
  folderWorkspaces: readonly FolderWorkspace[]
  deriveRepoManaged: boolean
}): FolderWorkspaceCreateIntent {
  if (!isRepoManagedProjectGroup(args.group)) {
    return { kind: 'create-folder' }
  }
  if (args.deriveRepoManaged) {
    return { kind: 'derive' }
  }
  const main = findMainFolderWorkspace(args.folderWorkspaces, args.group)
  return main ? { kind: 'activate-main', workspace: main } : { kind: 'create-main' }
}
