import type { WorkspaceLinkedItem } from './worktree/types'

/** Compares every field the normalizer preserves. A field left out here would
 *  let a stored item whose only difference is that field pass as unchanged, so
 *  the corrected value would never be written back. */
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
    (a.pluginKey ?? null) === (b.pluginKey ?? null) &&
    (a.sourceId ?? null) === (b.sourceId ?? null) &&
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
    raw.provider !== 'plugin'
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
    ...(typeof raw.pluginKey === 'string' && raw.pluginKey.trim().length > 0
      ? { pluginKey: raw.pluginKey.trim() }
      : {}),
    ...(typeof raw.sourceId === 'string' && raw.sourceId.trim().length > 0
      ? { sourceId: raw.sourceId.trim() }
      : {}),
    ...(typeof raw.repoId === 'string' && raw.repoId.trim().length > 0
      ? { repoId: raw.repoId.trim() }
      : {})
  }
}
