import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

export function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    ...overrides,
    id: overrides.id ?? 'folder-1',
    projectGroupId: overrides.projectGroupId ?? 'group-1',
    name: overrides.name ?? 'platform workspace',
    folderPath: overrides.folderPath ?? '/work/platform',
    linkedTask: overrides.linkedTask ?? null,
    comment: overrides.comment ?? '',
    isArchived: overrides.isArchived ?? false,
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    sortOrder: overrides.sortOrder ?? 0,
    manualOrder: overrides.manualOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    workspaceStatus: overrides.workspaceStatus ?? 'active'
  }
}
