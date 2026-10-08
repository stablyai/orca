import type { WorkspaceAttachment } from '../../../shared/worktree/types'
import {
  WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
} from '../../../shared/workspace-attachment-capabilities'
import { assertRuntimeEnvironmentCapability, type RuntimeClientTarget } from './runtime-rpc-client'
import { translate } from '@/i18n/i18n'

export async function assertWorkspaceAttachmentWriteCapability(
  target: RuntimeClientTarget,
  updates: { linkedItems?: WorkspaceAttachment[]; linkedItemsBase?: WorkspaceAttachment[] }
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  if (updates.linkedItemsBase !== undefined) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY,
      translate(
        'workspace.attachments.updateRuntimeSafely',
        'Update the remote runtime to safely change workspace links'
      )
    )
  }
  if (updates.linkedItems !== undefined) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
      translate(
        'workspace.attachments.updateRuntime',
        'Update the remote runtime to change workspace links'
      )
    )
  }
}
