import {
  recordCleanupWrite,
  forgetCleanupWrite,
  journaledCleanupWrites
} from './workspace-cleanup-write-journal'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type {
  WorkspaceCleanupPolicyChange,
  WorkspaceCleanupPolicyRead
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'

export function createWorkspaceCleanupPolicyWrite(
  owner: RuntimeClientTarget,
  change: WorkspaceCleanupPolicyChange,
  read: WorkspaceCleanupPolicyRead
) {
  change = structuredClone(change)
  read = structuredClone(read)
  const readback = async (receipt: 'applied' | 'cancelled' | 'unknown') => {
    let saved: WorkspaceCleanupPolicyRead
    try {
      saved = await callRuntimeRpc<WorkspaceCleanupPolicyRead>(
        owner,
        'workspaceCleanup.policyState',
        { repoId: read.state.repoId }
      )
    } catch (error) {
      if (!read.state.repoId) {
        throw error
      }
      const catalog = await callRuntimeRpc<WorkspaceCleanupPolicyRead>(
        owner,
        'workspaceCleanup.policyState',
        { repoId: null }
      )
      if (catalog.state.projects.some((project) => project.id === read.state.repoId)) {
        throw error
      }
      return { read: null, outcome: 'conflict' as const }
    }
    const actual = change.scope === 'global' ? saved.state.rules : saved.state.projects[0]?.policy
    const desired = change.scope === 'global' ? change.rules : change.policy
    return {
      read: saved,
      outcome:
        JSON.stringify(actual) === JSON.stringify(desired)
          ? ('saved' as const)
          : receipt === 'cancelled' && JSON.stringify(saved.state) === JSON.stringify(read.state)
            ? ('failed' as const)
            : ('conflict' as const)
    }
  }
  const guard = {
    id: createNonSecureContextUuid(),
    expiresAt: read.expiresAt,
    expected: read.state,
    requireReservation: true as const
  }
  return {
    forget: () => forgetCleanupWrite(owner, guard.id),
    send: async () => {
      recordCleanupWrite(owner, guard.id, guard.expiresAt)
      await callRuntimeRpc(owner, 'workspaceCleanup.reservePolicyWrite', guard)
      if (change.scope === 'global') {
        await callRuntimeRpc(owner, 'settings.update', {
          workspaceCleanupPolicy: change.rules,
          workspaceCleanupGuard: guard
        })
      } else if (owner.kind === 'local') {
        const result = await window.api.repos.update({
          repoId: change.repoId,
          hostId: 'local',
          updates: { workspaceCleanupPolicy: change.policy, workspaceCleanupGuard: guard }
        })
        if (!result) {
          throw new Error('workspace_cleanup_save_failed')
        }
      } else {
        await callRuntimeRpc(owner, 'repo.update', {
          repo: change.repoId,
          updates: { workspaceCleanupPolicy: change.policy, workspaceCleanupGuard: guard }
        })
      }
    },
    readback: () => readback('applied'),
    settle: async () => {
      const result = await callRuntimeRpc<{ outcome: 'applied' | 'cancelled' | 'unknown' }>(
        owner,
        'workspaceCleanup.settlePolicyWrite',
        { id: guard.id, expiresAt: guard.expiresAt }
      )
      return readback(result.outcome)
    }
  }
}

export async function readCleanupPolicy(
  owner: RuntimeClientTarget,
  repoId: string | null,
  onRecovery?: (recovering: boolean) => void,
  isCurrent: () => boolean = () => true
): Promise<WorkspaceCleanupPolicyRead> {
  const read = await callRuntimeRpc<WorkspaceCleanupPolicyRead>(
    owner,
    'workspaceCleanup.policyState',
    { repoId }
  )
  if (read.protocol !== 3 || !isCurrent()) {
    return read
  }
  const journal = journaledCleanupWrites(owner)
  if (!read.pendingWrites && !journal.length) {
    onRecovery?.(false)
    return read
  }
  onRecovery?.(true)
  for (const entry of journal) {
    if (!isCurrent()) {
      return read
    }
    if (entry.expiresAt > read.expiresAt) {
      throw new Error('workspace_cleanup_receipt_unavailable')
    }
    await callRuntimeRpc(owner, 'workspaceCleanup.settlePolicyWrite', {
      id: entry.id,
      expiresAt: read.expiresAt
    })
  }
  if (!isCurrent()) {
    return read
  }
  const recovered = await callRuntimeRpc<WorkspaceCleanupPolicyRead>(
    owner,
    'workspaceCleanup.recoverPolicyWrites',
    { repoId }
  )
  if (recovered.pendingWrites) {
    throw new Error('workspace_cleanup_write_pending')
  }
  for (const entry of journal) {
    forgetCleanupWrite(owner, entry.id)
  }
  onRecovery?.(false)
  return recovered
}
