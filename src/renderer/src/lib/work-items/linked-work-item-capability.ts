import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { CLICKUP_RUNTIME_CAPABILITY } from '../../../../shared/clickup/clickup-runtime-capability'
import { assertRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

// Older runtimes already advertise the linked-context capability yet reject ClickUp, so ClickUp has its own.
const ACCOUNT_BACKED_LINK_PROVIDERS = { jira: 'Jira', clickup: 'ClickUp' } as const
const ACCOUNT_BACKED_LINK_CAPABILITIES = {
  jira: WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  clickup: CLICKUP_RUNTIME_CAPABILITY
} as const

/**
 * Account-backed task links carry a task-source context that an older paired runtime would drop
 * silently, so a remote workspace write that links one needs a runtime that keeps it.
 */
export async function assertLinkedWorkItemContextCapability(
  target: RuntimeClientTarget,
  providers: readonly (string | null | undefined)[]
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  for (const provider of providers) {
    if (provider === 'jira' || provider === 'clickup') {
      await assertRuntimeEnvironmentCapability(
        target.environmentId,
        ACCOUNT_BACKED_LINK_CAPABILITIES[provider],
        `Update the remote runtime to link ${ACCOUNT_BACKED_LINK_PROVIDERS[provider]}`
      )
    }
  }
}
