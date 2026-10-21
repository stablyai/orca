import { WORKTREE_TAGS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { assertRuntimeEnvironmentCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { translate } from '@/i18n/i18n'

/** Refuses a tag write to a paired runtime that predates tags, which would drop it silently. */
export async function assertWorkspaceTagWriteCapability(
  target: RuntimeClientTarget
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    WORKTREE_TAGS_RUNTIME_CAPABILITY,
    translate(
      'auto.store.slices.worktrees.metadata.worktree.meta.persist.tags',
      'Update the remote runtime to tag workspaces'
    )
  )
}
