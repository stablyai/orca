// orca-fork: rodrillet/orca feature switches; upstream never edits this file, so merges keep it.

export const FORK_REPOSITORY = 'rodrillet/orca'

export const FORK_FEATURES = {
  /** Upstream's updater would replace the custom build (and a paired fork server) with a stock one. */
  upstreamUpdater: false
} as const
