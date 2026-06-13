import type { FolderWorkspace, FolderWorkspaceLinkedTask, ProjectGroup } from './types'
import { isTuiAgent } from './tui-agent-config'

export function normalizeFolderWorkspaceName(
  name: string | null | undefined,
  fallback = 'Untitled workspace'
): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed.length > 0 ? trimmed : fallback
}

export function normalizeFolderWorkspaceLinkedTask(
  value: unknown
): FolderWorkspaceLinkedTask | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<FolderWorkspaceLinkedTask>
  if (
    raw.provider !== 'github' &&
    raw.provider !== 'gitlab' &&
    raw.provider !== 'linear' &&
    raw.provider !== 'jira'
  ) {
    return null
  }
  if (raw.type !== 'issue' && raw.type !== 'pr' && raw.type !== 'mr') {
    return null
  }
  if (
    typeof raw.number !== 'number' ||
    !Number.isFinite(raw.number) ||
    typeof raw.title !== 'string' ||
    raw.title.trim().length === 0 ||
    typeof raw.url !== 'string' ||
    raw.url.trim().length === 0
  ) {
    return null
  }
  return {
    provider: raw.provider,
    type: raw.type,
    number: raw.number,
    title: raw.title.trim(),
    url: raw.url.trim(),
    ...(typeof raw.linearIdentifier === 'string' && raw.linearIdentifier.trim().length > 0
      ? { linearIdentifier: raw.linearIdentifier.trim() }
      : {}),
    ...(typeof raw.jiraIdentifier === 'string' && raw.jiraIdentifier.trim().length > 0
      ? { jiraIdentifier: raw.jiraIdentifier.trim() }
      : {}),
    ...(typeof raw.repoId === 'string' && raw.repoId.trim().length > 0
      ? { repoId: raw.repoId.trim() }
      : {})
  }
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
      linkedTask: normalizeFolderWorkspaceLinkedTask(raw.linkedTask),
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
