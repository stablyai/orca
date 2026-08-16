import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import { isTuiAgent } from './tui-agent-config'
import { normalizeStoredTaskSourceContext } from './task-source-context'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from './workspace-linked-item-source-context'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'

export function normalizeFolderWorkspaceName(
  name: string | null | undefined,
  fallback = 'Untitled workspace'
): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed.length > 0 ? trimmed : fallback
}

export function normalizeFolderWorkspaces(
  value: unknown,
  projectGroups: readonly ProjectGroup[]
): FolderWorkspace[] {
  if (!Array.isArray(value)) {
    return []
  }
  const folderGroups = new Map<string, ProjectGroup>()
  for (const group of projectGroups) {
    if (group.parentPath) {
      folderGroups.set(group.id, group)
    }
  }

  const workspaces: FolderWorkspace[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<FolderWorkspace>
    if (
      typeof raw.id !== 'string' ||
      raw.id.trim().length === 0 ||
      seen.has(raw.id) ||
      typeof raw.projectGroupId !== 'string' ||
      !folderGroups.has(raw.projectGroupId)
    ) {
      continue
    }
    const group = folderGroups.get(raw.projectGroupId)
    const folderPath =
      typeof raw.folderPath === 'string' && raw.folderPath.trim().length > 0
        ? raw.folderPath
        : group?.parentPath
    if (!folderPath) {
      continue
    }
    const now = Date.now()
    const linkedTask = normalizeWorkspaceLinkedItem(raw.linkedTask)
    const linkedTaskSourceContext = normalizeStoredTaskSourceContext(raw.linkedTaskSourceContext)
    const creatorProvenance = normalizeWorkspaceCreatorProvenance(raw.creatorProvenance)
    seen.add(raw.id)
    workspaces.push({
      id: raw.id,
      projectGroupId: raw.projectGroupId,
      name: normalizeFolderWorkspaceName(raw.name),
      folderPath,
      connectionId:
        typeof raw.connectionId === 'string'
          ? raw.connectionId
          : raw.connectionId === null
            ? null
            : (group?.connectionId ?? null),
      ...(creatorProvenance ? { creatorProvenance } : {}),
      linkedTask,
      linkedTaskSourceContext: isWorkspaceLinkedItemSourceContextMatch(
        linkedTask,
        linkedTaskSourceContext
      )
        ? linkedTaskSourceContext
        : null,
      comment: typeof raw.comment === 'string' ? raw.comment : '',
      isArchived: raw.isArchived === true,
      isUnread: raw.isUnread === true,
      isPinned: raw.isPinned === true,
      sortOrder:
        typeof raw.sortOrder === 'number' && Number.isFinite(raw.sortOrder) ? raw.sortOrder : now,
      ...(typeof raw.manualOrder === 'number' && Number.isFinite(raw.manualOrder)
        ? { manualOrder: raw.manualOrder }
        : {}),
      ...(typeof raw.workspaceStatus === 'string' && raw.workspaceStatus.trim().length > 0
        ? { workspaceStatus: raw.workspaceStatus }
        : {}),
      ...(isTuiAgent(raw.createdWithAgent) ? { createdWithAgent: raw.createdWithAgent } : {}),
      ...(raw.pendingFirstAgentMessageRename === true
        ? { pendingFirstAgentMessageRename: true }
        : {}),
      ...(typeof raw.firstAgentMessageRenameError === 'string'
        ? { firstAgentMessageRenameError: raw.firstAgentMessageRenameError }
        : raw.firstAgentMessageRenameError === null
          ? { firstAgentMessageRenameError: null }
          : {}),
      lastActivityAt:
        typeof raw.lastActivityAt === 'number' && Number.isFinite(raw.lastActivityAt)
          ? raw.lastActivityAt
          : 0,
      createdAt:
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt:
        typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      // Legacy read: unreleased #14112 builds wrote notes inline. Canonical home is
      // PersistedState.folderWorkspaceDiffComments.
      ...(Array.isArray(raw.diffComments) ? { diffComments: raw.diffComments } : {})
    })
  }
  return workspaces.sort(
    (left, right) => right.sortOrder - left.sortOrder || left.name.localeCompare(right.name)
  )
}
