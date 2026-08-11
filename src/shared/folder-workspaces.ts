import type { FolderWorkspace, ProjectGroup } from './types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { isTuiAgent } from './tui-agent-config'
import { normalizeStoredTaskSourceContext } from './task-source-context'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from './workspace-linked-item-source-context'

export function normalizeFolderWorkspaceName(
  name: string | null | undefined,
  fallback = 'Untitled workspace'
): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed.length > 0 ? trimmed : fallback
}

function getNormalizedFolderWorkspaceHostId(
  workspace: Partial<FolderWorkspace>,
  group: ProjectGroup | undefined
): ExecutionHostId {
  const workspaceHostId = normalizeExecutionHostId(workspace.executionHostId)
  if (workspaceHostId) {
    return workspaceHostId
  }
  if (typeof workspace.connectionId === 'string') {
    return toSshExecutionHostId(workspace.connectionId)
  }
  if (workspace.connectionId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const groupHostId = normalizeExecutionHostId(group?.executionHostId)
  if (groupHostId) {
    return groupHostId
  }
  return group?.connectionId ? toSshExecutionHostId(group.connectionId) : LOCAL_EXECUTION_HOST_ID
}

export function normalizeFolderWorkspaces(
  value: unknown,
  projectGroups: readonly ProjectGroup[]
): FolderWorkspace[] {
  if (!Array.isArray(value)) {
    return []
  }
  const folderGroupsByIdentity = new Map<string, ProjectGroup>()
  const folderGroupsById = new Map<string, ProjectGroup[]>()
  for (const group of projectGroups) {
    if (group.parentPath) {
      folderGroupsByIdentity.set(
        `${getNormalizedFolderWorkspaceHostId({}, group)}\0${group.id}`,
        group
      )
      const matchingGroups = folderGroupsById.get(group.id) ?? []
      matchingGroups.push(group)
      folderGroupsById.set(group.id, matchingGroups)
    }
  }

  const workspaces: FolderWorkspace[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<FolderWorkspace>
    const candidateGroups =
      typeof raw.projectGroupId === 'string' ? (folderGroupsById.get(raw.projectGroupId) ?? []) : []
    const rawHostId = getNormalizedFolderWorkspaceHostId(raw, undefined)
    const group =
      typeof raw.projectGroupId === 'string'
        ? (folderGroupsByIdentity.get(`${rawHostId}\0${raw.projectGroupId}`) ??
          (candidateGroups.length === 1 ? candidateGroups[0] : undefined))
        : undefined
    const executionHostId = getNormalizedFolderWorkspaceHostId(raw, group)
    const identity = `${executionHostId}\0${raw.id ?? ''}`
    if (
      typeof raw.id !== 'string' ||
      raw.id.trim().length === 0 ||
      seen.has(identity) ||
      typeof raw.projectGroupId !== 'string' ||
      !group
    ) {
      continue
    }
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
    seen.add(identity)
    workspaces.push({
      id: raw.id,
      projectGroupId: raw.projectGroupId,
      name: normalizeFolderWorkspaceName(raw.name),
      folderPath,
      ...(typeof raw.connectionId === 'string' || raw.connectionId === null
        ? { connectionId: raw.connectionId }
        : {}),
      ...(normalizeExecutionHostId(raw.executionHostId) ? { executionHostId } : {}),
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
        typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
    })
  }
  return workspaces.sort(
    (left, right) => right.sortOrder - left.sortOrder || left.name.localeCompare(right.name)
  )
}
