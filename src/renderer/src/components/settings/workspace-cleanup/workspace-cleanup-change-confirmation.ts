import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  WorkspaceCleanupPolicyRead,
  WorkspaceCleanupPolicyChange,
  WorkspaceCleanupPolicyComparison
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupPreviewRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  proposedCleanupPolicy,
  cleanupPolicyHasEnabledRules,
  type CleanupChangeIntent
} from './workspace-cleanup-rule-change-intent'
import {
  cleanupAddedRows,
  cleanupChangeRowKey,
  cleanupDestructiveRows,
  cleanupNewRowsFirst
} from './workspace-cleanup-change-preview'
import type { WorkspaceCleanupRuleChangeRequest } from './workspace-cleanup-rule-change-dialog'

type Confirmation =
  | { kind: 'cancelled' }
  | { kind: 'refresh'; request: WorkspaceCleanupRuleChangeRequest }
  | { kind: 'pin-failed'; row: WorkspaceCleanupPreviewRow }
  | {
      kind: 'ready'
      change: WorkspaceCleanupPolicyChange
      read: WorkspaceCleanupPolicyRead
      preview: WorkspaceCleanupPreview
    }

export function previewCleanupPolicyChange(
  owner: RuntimeClientTarget,
  change: WorkspaceCleanupPolicyChange,
  disabledRead?: WorkspaceCleanupPolicyRead
) {
  if (disabledRead && !cleanupPolicyHasEnabledRules(disabledRead, change)) {
    const empty = { evaluatedAt: 0, rows: [] }
    return Promise.resolve({ current: empty, next: empty, read: disabledRead })
  }
  return callRuntimeRpc<WorkspaceCleanupPolicyComparison>(
    owner,
    'workspaceCleanup.previewChange',
    change,
    { timeoutMs: 10 * 60 * 1000 }
  )
}

export async function confirmWorkspaceCleanupChange(
  owner: RuntimeClientTarget,
  pending: WorkspaceCleanupRuleChangeRequest & { intent: CleanupChangeIntent },
  repoId: string | null,
  isCurrent: () => boolean
): Promise<Confirmation> {
  const latest = await callRuntimeRpc<WorkspaceCleanupPolicyRead>(
    owner,
    'workspaceCleanup.policyState',
    { repoId }
  )
  return complete(owner, pending, latest, isCurrent)
}

async function complete(
  owner: RuntimeClientTarget,
  pending: WorkspaceCleanupRuleChangeRequest & { intent: CleanupChangeIntent },
  latest: WorkspaceCleanupPolicyRead,
  isCurrent: () => boolean
): Promise<Confirmation> {
  if (!isCurrent()) {
    return { kind: 'cancelled' }
  }
  const change = proposedCleanupPolicy(latest, pending.intent)
  const comparison = await previewCleanupPolicyChange(
    owner,
    change,
    pending.kind === 'disable-ignored-files' && !pending.kept.size ? latest : undefined
  )
  if (!isCurrent()) {
    return { kind: 'cancelled' }
  }
  const rows = cleanupDestructiveRows(comparison.next)
  const added = cleanupAddedRows(rows, pending.rows)
  const allKeys = new Set(comparison.next.rows.map(cleanupChangeRowKey))
  const missing = [...(pending.keepRefs?.values() ?? [])].filter(
    (row) => pending.kept.has(cleanupChangeRowKey(row)) && !allKeys.has(cleanupChangeRowKey(row))
  )
  if (missing.length) {
    if (missing.some((row) => !row.instanceId)) {
      throw new Error('workspace_cleanup_identity_unknown')
    }
    const proof = await callRuntimeRpc<{ deleted: string[] }>(
      owner,
      'workspaceCleanup.inspectKept',
      { rows: missing.map((row) => ({ worktreeId: row.worktreeId, instanceId: row.instanceId! })) }
    )
    if (!isCurrent()) {
      return { kind: 'cancelled' }
    }
    if (proof.deleted.length !== missing.length) {
      throw new Error('workspace_cleanup_identity_unknown')
    }
  }
  const kept = new Set([...pending.kept].filter((key) => allKeys.has(key)))
  const keepRefs = new Map([...(pending.keepRefs ?? [])].filter(([key]) => kept.has(key)))
  const currentKeys = new Set(cleanupDestructiveRows(comparison.current).map(cleanupChangeRowKey))
  if (added.size || missing.length) {
    return {
      kind: 'refresh',
      request: {
        ...pending,
        rows: cleanupNewRowsFirst(rows, added),
        newKeys: added,
        currentKeys,
        kept,
        keepRefs,
        status: { added: added.size, deleted: missing.map((row) => row.displayName) }
      }
    }
  }
  for (const row of comparison.next.rows.filter((item) => kept.has(cleanupChangeRowKey(item)))) {
    if (!isCurrent()) {
      return { kind: 'cancelled' }
    }
    if (!row.instanceId) {
      return { kind: 'pin-failed', row }
    }
    try {
      await callRuntimeRpc(
        owner,
        'workspaceCleanup.pin',
        { worktreeId: row.worktreeId, instanceId: row.instanceId },
        { timeoutMs: 10 * 60 * 1000 }
      )
    } catch {
      if (!isCurrent()) {
        return { kind: 'cancelled' }
      }
      try {
        const proof = await callRuntimeRpc<{ deleted: string[]; pinned: string[] }>(
          owner,
          'workspaceCleanup.inspectKept',
          { rows: [{ worktreeId: row.worktreeId, instanceId: row.instanceId }] }
        )
        if (!isCurrent()) {
          return { kind: 'cancelled' }
        }
        if (proof.deleted.includes(row.worktreeId)) {
          kept.delete(cleanupChangeRowKey(row))
          keepRefs.delete(cleanupChangeRowKey(row))
          return {
            kind: 'refresh',
            request: {
              ...pending,
              rows: rows.filter((item) => cleanupChangeRowKey(item) !== cleanupChangeRowKey(row)),
              newKeys: new Set(),
              currentKeys,
              kept,
              keepRefs,
              status: { added: 0, deleted: [row.displayName] }
            }
          }
        }
        if (proof.pinned.includes(row.worktreeId)) {
          continue
        }
      } catch {
        return { kind: 'pin-failed', row }
      }
      return { kind: 'pin-failed', row }
    }
  }
  return {
    kind: 'ready',
    change,
    read: comparison.read,
    preview: {
      ...comparison.next,
      rows: comparison.next.rows.map((row) =>
        kept.has(cleanupChangeRowKey(row))
          ? { ...row, evaluation: { action: 'keep', cause: 'pinned' } }
          : row
      )
    }
  }
}
