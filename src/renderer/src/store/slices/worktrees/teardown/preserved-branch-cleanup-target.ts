import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { PreservedBranchCleanup } from '../../../../../../shared/preserved-branch-cleanup'

export const preservedBranchRuntimeTargetByCleanupKey = new Map<
  string,
  { cleanup: PreservedBranchCleanup; target: RuntimeClientTarget }
>()
