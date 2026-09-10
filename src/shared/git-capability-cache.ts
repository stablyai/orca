import { CapabilityProbeCache } from './capability-probe-cache'

// Why: suppress hot-loop failures while still detecting an in-place Git
// upgrade during a long Orca session without requiring a restart.
export const GIT_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000

export type GitCapability =
  | 'fetch-no-write-fetch-head'
  | 'for-each-ref-exclude'
  | 'merge-tree-merge-base'
  | 'merge-tree-write-tree'
  | 'rev-parse-path-format'
  | 'worktree-list-z'

export class GitCapabilityCache extends CapabilityProbeCache<GitCapability> {
  constructor() {
    super(GIT_CAPABILITY_RETRY_INTERVAL_MS)
  }
}
