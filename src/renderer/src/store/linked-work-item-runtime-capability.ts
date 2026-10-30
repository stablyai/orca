import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  WORKTREE_LINKED_WORK_ITEM_AZURE_DEVOPS_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

export type LinkedWorkItemCapabilityGate = {
  environmentId: string
  capability: RuntimeCapability
  message: string
}

/**
 * An older paired runtime drops a link it cannot parse, silently. Worktree and
 * folder-workspace mutations gate on the same capabilities; returning the gates
 * instead of asserting them keeps the unaffected path free of an extra await.
 */
export function linkedWorkItemRuntimeCapabilityGates(
  target: RuntimeClientTarget,
  providers: readonly (string | null | undefined)[]
): LinkedWorkItemCapabilityGate[] {
  if (target.kind !== 'environment') {
    return []
  }
  const environmentId = target.environmentId
  const gates: LinkedWorkItemCapabilityGate[] = []
  if (providers.includes('jira')) {
    gates.push({
      environmentId,
      capability: WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
      message: 'Update the remote runtime to link Jira'
    })
  }
  if (providers.includes('azure-devops')) {
    gates.push({
      environmentId,
      capability: WORKTREE_LINKED_WORK_ITEM_AZURE_DEVOPS_RUNTIME_CAPABILITY,
      message: 'Update the remote runtime to link Azure DevOps'
    })
  }
  return gates
}
