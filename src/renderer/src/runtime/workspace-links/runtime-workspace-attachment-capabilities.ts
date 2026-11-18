import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import {
  WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
} from '../../../../shared/workspace-attachments/workspace-attachment-capabilities'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { getContextOnlyLinkProviderLabel } from '../../../../shared/workspace-attachments/workspace-linked-item'
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
}

// Why: an older paired runtime would drop a Jira/Todoist link silently.
export async function assertContextOnlyLinkCapability(
  target: RuntimeClientTarget,
  ...providers: (string | null | undefined)[]
): Promise<void> {
  const provider = getContextOnlyLinkProviderLabel(...providers)
  if (target.kind === 'environment' && provider) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
      `Update the remote runtime to link ${provider}`
    )
  }
}
