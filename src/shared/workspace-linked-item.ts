import type { WorkspaceLinkedItem } from './worktree/types'

export function areWorkspaceLinkedItemsEqual(
  a: WorkspaceLinkedItem | null | undefined,
  b: WorkspaceLinkedItem | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.provider === b.provider &&
    a.type === b.type &&
    a.number === b.number &&
    a.title === b.title &&
    a.url === b.url &&
    (a.linearIdentifier ?? null) === (b.linearIdentifier ?? null) &&
    (a.jiraIdentifier ?? null) === (b.jiraIdentifier ?? null) &&
    (a.paperclipIssueId ?? null) === (b.paperclipIssueId ?? null) &&
    (a.paperclipIdentifier ?? null) === (b.paperclipIdentifier ?? null) &&
    (a.paperclipConnectionId ?? null) === (b.paperclipConnectionId ?? null) &&
    (a.paperclipCompanyId ?? null) === (b.paperclipCompanyId ?? null) &&
    (a.paperclipProjectId ?? null) === (b.paperclipProjectId ?? null) &&
    (a.repoId ?? null) === (b.repoId ?? null)
  )
}

export function normalizeWorkspaceLinkedItem(value: unknown): WorkspaceLinkedItem | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<WorkspaceLinkedItem>
  if (
    raw.provider !== 'github' &&
    raw.provider !== 'gitlab' &&
    raw.provider !== 'linear' &&
    raw.provider !== 'jira' &&
    raw.provider !== 'paperclip'
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
    ...(typeof raw.paperclipIssueId === 'string' && raw.paperclipIssueId.trim().length > 0
      ? { paperclipIssueId: raw.paperclipIssueId.trim() }
      : {}),
    ...(typeof raw.paperclipIdentifier === 'string' && raw.paperclipIdentifier.trim().length > 0
      ? { paperclipIdentifier: raw.paperclipIdentifier.trim() }
      : {}),
    ...(typeof raw.paperclipConnectionId === 'string' && raw.paperclipConnectionId.trim().length > 0
      ? { paperclipConnectionId: raw.paperclipConnectionId.trim() }
      : {}),
    ...(typeof raw.paperclipCompanyId === 'string' && raw.paperclipCompanyId.trim().length > 0
      ? { paperclipCompanyId: raw.paperclipCompanyId.trim() }
      : {}),
    ...(typeof raw.paperclipProjectId === 'string' && raw.paperclipProjectId.trim().length > 0
      ? { paperclipProjectId: raw.paperclipProjectId.trim() }
      : {}),
    ...(typeof raw.repoId === 'string' && raw.repoId.trim().length > 0
      ? { repoId: raw.repoId.trim() }
      : {})
  }
}
