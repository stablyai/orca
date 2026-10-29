import { CapabilityProbeCache } from './capability-probe-cache'

// Suppress hot-loop failures while detecting in-place Git upgrades during long sessions.
export const GIT_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000

export type GitCapability =
  | 'fetch-no-write-fetch-head'
  | 'for-each-ref-exclude'
  | 'merge-tree-merge-base'
  | 'merge-tree-write-tree'
  | 'rev-parse-path-format'
  | 'worktree-add-lock-reason'
  | 'worktree-list-z'

export class GitCapabilityCache extends CapabilityProbeCache<GitCapability> {
  constructor() {
    super(GIT_CAPABILITY_RETRY_INTERVAL_MS)
  }
}
