import { readCleanupPolicy } from './workspace-cleanup-policy-client'
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
  | { kind: 'pin-failed'; row: WorkspaceCleanupPreviewRow; tooLate?: boolean }
  | {
      kind: 'ready'
      change: WorkspaceCleanupPolicyChange
      read: WorkspaceCleanupPolicyRead
      preview: WorkspaceCleanupPreview
    }

export function previewCleanupPolicyChange(
  owner: RuntimeClientTarget,
  change: WorkspaceCleanupPolicyChange,
  read: WorkspaceCleanupPolicyRead,
  allowDisabled = false,
  fresh = false
) {
  if (allowDisabled && !cleanupPolicyHasEnabledRules(read, change)) {
    const empty = { evaluatedAt: 0, rows: [] }
    return Promise.resolve({ current: empty, next: empty, read })
  }
  return callRuntimeRpc<WorkspaceCleanupPolicyComparison>(
    owner,
    'workspaceCleanup.previewChange',
    { change, expected: read.state, fresh },
    { timeoutMs: 10 * 60 * 1000 }
  ).then((comparison) => {
    if (JSON.stringify(comparison.read.state) !== JSON.stringify(read.state)) {
      throw new Error('workspace_cleanup_policy_conflict')
    }
    return comparison
  })
}

export async function confirmWorkspaceCleanupChange(
  owner: RuntimeClientTarget,
  pending: WorkspaceCleanupRuleChangeRequest & { intent: CleanupChangeIntent },
  repoId: string | null,
  isCurrent: () => boolean
): Promise<Confirmation> {
  const latest = await readCleanupPolicy(owner, repoId, undefined, isCurrent)
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
    latest,
    pending.kind === 'disable-ignored-files' && !pending.selection.getSnapshot().count,
    true
  )
  if (!isCurrent()) {
    return { kind: 'cancelled' }
  }
  const rows = cleanupDestructiveRows(comparison.next)
  const added = cleanupAddedRows(rows, pending.rows)
  const allKeys = new Set(comparison.next.rows.map(cleanupChangeRowKey))
  const missing = [...pending.selection.rows()].filter(
    (row) => !allKeys.has(cleanupChangeRowKey(row))
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
  const kept = pending.selection.copyFor(rows, allKeys, added)
  if (!pending.reviewed) {
    throw new Error('workspace_cleanup_review_unavailable')
  }
  const reviewed = {
    state: structuredClone(comparison.read.state),
    change: structuredClone(change)
  }
  const policyChanged = JSON.stringify(reviewed) !== JSON.stringify(pending.reviewed)
  const currentKeys = new Set(cleanupDestructiveRows(comparison.current).map(cleanupChangeRowKey))
  if (policyChanged || added.size || missing.length) {
    return {
      kind: 'refresh',
      request: {
        ...pending,
        rows: cleanupNewRowsFirst(rows, added),
        newKeys: added,
        currentKeys,
        selection: kept,
        reviewed,
        status: { added: added.size, deleted: missing.map((row) => row.displayName), policyChanged }
      }
    }
  }

  const keepRows = comparison.next.rows.filter((row) => kept.has(cleanupChangeRowKey(row)))
  if (keepRows.length) {
    const invalid = keepRows.find((row) => !row.instanceId)
    if (invalid) {
      return { kind: 'pin-failed', row: invalid }
    }
    const refs = {
      rows: keepRows.map((row) => ({
        worktreeId: row.worktreeId,
        instanceId: row.instanceId!
      }))
    }
    let proof: { pinned: string[]; deleted: string[]; tooLate?: string[] }
    try {
      const result = await callRuntimeRpc<{
        pinned: string[]
        deleted: string[]
        failed: string[]
        tooLate?: string[]
      }>(owner, 'workspaceCleanup.pinBatch', refs, { timeoutMs: 10 * 60 * 1000 })
      proof = result.failed.length
        ? await callRuntimeRpc(owner, 'workspaceCleanup.inspectKept', refs)
        : result
    } catch {
      try {
        proof = await callRuntimeRpc(owner, 'workspaceCleanup.inspectKept', refs)
      } catch {
        return { kind: 'pin-failed', row: keepRows[0] }
      }
    }
    if (!isCurrent()) {
      return { kind: 'cancelled' }
    }
    const tooLateKeys = new Set(proof.tooLate)
    const tooLate = keepRows.find((row) => tooLateKeys.has(row.worktreeId))
    if (tooLate) {
      return { kind: 'pin-failed', row: tooLate, tooLate: true }
    }
    const gone = new Set(proof.deleted)
    const removed = keepRows.filter((row) => gone.has(row.worktreeId))
    if (removed.length) {
      const removedKeys = new Set(removed.map(cleanupChangeRowKey))
      return {
        kind: 'refresh',
        request: {
          ...pending,
          rows: rows.filter((row) => !removedKeys.has(cleanupChangeRowKey(row))),
          newKeys: new Set(),
          currentKeys,
          selection: kept.copyFor(
            rows.filter((row) => !removedKeys.has(cleanupChangeRowKey(row))),
            new Set([...allKeys].filter((key) => !removedKeys.has(key)))
          ),
          reviewed,
          status: { added: 0, deleted: removed.map((row) => row.displayName) }
        }
      }
    }
    const pinned = new Set(proof.pinned)
    const failed = keepRows.find((row) => !pinned.has(row.worktreeId))
    if (failed) {
      return { kind: 'pin-failed', row: failed }
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
