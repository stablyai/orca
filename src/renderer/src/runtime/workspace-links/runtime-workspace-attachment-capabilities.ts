import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import {
  WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
} from '../../../../shared/workspace-attachments/workspace-attachment-capabilities'
import { CLICKUP_RUNTIME_CAPABILITY } from '../../../../shared/clickup/clickup-runtime-capability'
import { assertRuntimeEnvironmentCapability } from '../rpc/compatibility/runtime-capability-proof'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
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
  // An older runtime normalizes unknown providers away, so ClickUp links would vanish without an error.
  if (updates.linkedItems?.some((item) => item.provider === 'clickup')) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      CLICKUP_RUNTIME_CAPABILITY,
      'Update the remote runtime to link ClickUp'
    )
  }
}
