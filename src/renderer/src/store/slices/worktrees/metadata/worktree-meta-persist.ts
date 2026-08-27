import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../../../runtime/runtime-rpc-client'
import {
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../../../types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { encodePushTargetClearForRuntimeRpc } from './hosted-review-link-mutation'

export async function persistWorktreeMeta(
  settings: AppState['settings'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    await window.api.worktrees.updateMeta({ worktreeId, updates })
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
  await callRuntimeRpc(
    target,
    'worktree.set',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      ...encodePushTargetClearForRuntimeRpc(updates)
    },
    { timeoutMs: 15_000 }
  )
}
