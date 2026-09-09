import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '../../../../runtime/runtime-rpc-client'
import {
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../../../types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { encodePushTargetClearForRuntimeRpc } from './hosted-review-link-mutation'

type PendingDisplayNameWrite = {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

const pendingDisplayNameWrites = new Set<PendingDisplayNameWrite>()

function pendingDisplayNameWriteMatches(
  write: PendingDisplayNameWrite,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  return (
    write.worktreeId === worktreeId &&
    (write.executionHostId === undefined ||
      executionHostId === undefined ||
      write.executionHostId === executionHostId)
  )
}

export function isDisplayNamePersistencePending(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  for (const write of pendingDisplayNameWrites) {
    if (pendingDisplayNameWriteMatches(write, worktreeId, executionHostId)) {
      return true
    }
  }
  return false
}

export function persistWorktreeMeta(
  settings: AppState['settings'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId,
  identityKey?: string
): Promise<void> {
  const operation = persistWorktreeMetaUntracked(
    settings,
    worktreeId,
    updates,
    executionHostId,
    identityKey
  )
  if (!('displayName' in updates)) {
    return operation
  }
  const write: PendingDisplayNameWrite = {
    worktreeId,
    executionHostId
  }
  pendingDisplayNameWrites.add(write)
  void operation.then(
    () => pendingDisplayNameWrites.delete(write),
    () => pendingDisplayNameWrites.delete(write)
  )
  return operation
}

async function persistWorktreeMetaUntracked(
  settings: AppState['settings'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId,
  identityKey?: string
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    await window.api.worktrees.updateMeta({
      worktreeId,
      ...(executionHostId ? { executionHostId } : {}),
      updates
    })
    return
  }
  // Why: `worktree.set` parses in strip mode, so an older runtime drops the key
  // and applies the rest. Both gates key off presence, not value — a dropped
  // *clear* strands a stale link that the Issue row then hides.
  if (
    target.kind === 'environment' &&
    ('linkedWorkItem' in updates || 'linkedTaskSourceContext' in updates)
  ) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
      translate(
        'auto.store.slices.worktrees.metadata.worktree.meta.persist.877e3638d8',
        'Update the remote runtime to change this workspace’s linked issue'
      )
    )
  }
  // task-source-context.v1 is a sound proxy for the Linear keys: #5322 added them
  // to the schema and is an ancestor of the commit introducing that capability.
  if (target.kind === 'environment' && 'linkedLinearIssue' in updates) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
      translate(
        'auto.store.slices.worktrees.metadata.worktree.meta.persist.4367540861',
        'Update the remote runtime to link Linear issues'
      )
    )
  }
  let compatibleUpdates = updates
  if (target.kind === 'environment' && 'suppressedGitHubPR' in updates) {
    if (typeof updates.suppressedGitHubPR === 'number' && updates.suppressedGitHubPR > 0) {
      await assertRuntimeEnvironmentCapability(
        target.environmentId,
        WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
        translate(
          'auto.store.slices.worktrees.metadata.worktree.meta.persist.github.pr.suppression',
          'Update the remote runtime to unlink GitHub pull requests'
        )
      )
    } else if (
      updates.suppressedGitHubPR === null &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY
      ))
    ) {
      const olderHostUpdates = { ...updates }
      delete olderHostUpdates.suppressedGitHubPR
      compatibleUpdates = olderHostUpdates
    }
  }
  await callRuntimeRpc(
    target,
    'worktree.set',
    {
      worktree: identityKey ? `identity:${identityKey}` : toRuntimeWorktreeSelector(worktreeId),
      ...encodePushTargetClearForRuntimeRpc(compatibleUpdates)
    },
    { timeoutMs: 15_000 }
  )
}
