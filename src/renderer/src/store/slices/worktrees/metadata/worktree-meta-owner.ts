import type { AppState } from '../../../types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { findIndexedDetectedWorktrees } from '@/lib/worktree-runtime-owner-index'
import { worktreeRowMatchesMetaHost } from '../listing/worktree-meta-host-match'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'

type KnownWorktree = Worktree | DetectedWorktreeListResult['worktrees'][number]

function ownerKey(
  worktree: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
): string {
  return JSON.stringify([
    worktree.repoId,
    parseExecutionHostId(worktree.hostId)?.id ?? LOCAL_EXECUTION_HOST_ID,
    worktree.runtimeOwnerEnvironmentId?.trim() || null
  ])
}

export function findWorktreeMetaOwner(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): KnownWorktree | undefined {
  if (!executionHostId || parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return findKnownWorktreeById(state, worktreeId, executionHostId)
  }
  const visible = (state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (worktree) =>
      worktree.id === worktreeId && worktreeRowMatchesMetaHost(worktree, executionHostId)
  )
  const detected = findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId).filter(
    (worktree) => worktreeRowMatchesMetaHost(worktree, executionHostId)
  )
  const ownerKeys = new Set([...visible, ...detected].map(ownerKey))
  return ownerKeys.size === 1 ? (visible[0] ?? detected[0]) : undefined
}
