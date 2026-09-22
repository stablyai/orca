import { toast } from 'sonner'
import { WORKTREE_LINKED_WORK_ITEM_PLUGIN_PROVIDER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'

/** The linked item a create call may carry to `target`.
 *
 *  A contributed (`'plugin'`) item bound for a paired host that predates the
 *  provider arm comes back `undefined`: that host's param schema refuses the
 *  whole create rather than dropping the unknown provider, so sending it would
 *  cost the workspace and not just the link. Losing the link is the degrade the
 *  read path already takes; losing the workspace is not. Every other item, and
 *  every local target, is returned untouched. */
export async function resolveHostSupportedLinkedWorkItem<T extends WorkspaceLinkedItem>(
  target: RuntimeClientTarget,
  item: T | null | undefined
): Promise<T | null | undefined> {
  if (target.kind !== 'environment' || item?.provider !== 'plugin') {
    return item
  }
  if (
    await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      WORKTREE_LINKED_WORK_ITEM_PLUGIN_PROVIDER_RUNTIME_CAPABILITY
    )
  ) {
    return item
  }
  toast.warning(
    translate(
      'auto.store.plugin.linked.item.host.support.droppedTitle',
      'Linked item left off this workspace'
    ),
    {
      description: translate(
        'auto.store.plugin.linked.item.host.support.droppedDescription',
        'This remote Orca server is too old to store links from installed plugins. Update the server to keep them.'
      )
    }
  )
  return undefined
}
