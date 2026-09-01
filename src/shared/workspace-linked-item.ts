import { isTaskProvider } from './task-providers'
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
    (a.repoId ?? null) === (b.repoId ?? null) &&
    // Why: Odoo ticket ids only identify a ticket within one instance, so two
    // instances can hand out the same number for unrelated tickets.
    (a.odooInstanceId ?? null) === (b.odooInstanceId ?? null)
  )
}

export function normalizeWorkspaceLinkedItem(value: unknown): WorkspaceLinkedItem | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<WorkspaceLinkedItem>
  // Why derived rather than an inline list: this check kept 'odoo' out while the
  // type gained it, so every Odoo linked item normalized to null. Reusing the
  // single TASK_PROVIDERS source of truth makes that drift impossible.
  if (!isTaskProvider(raw.provider)) {
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
      : {}),
    ...(typeof raw.odooInstanceId === 'string' && raw.odooInstanceId.trim().length > 0
      ? { odooInstanceId: raw.odooInstanceId.trim() }
      : {})
  }
}
