import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export type GitRuntimeOperationOptions = {
  /** The worktree owner's transport; absent resolves it from the worktree's rows. */
  runtimeTarget?: RuntimeClientTarget | null
  applyUpstreamStatus?: boolean
  /** Store slot for upstream status when it differs from worktreeId (nested repos inside a workspace). */
  statusKey?: string
}
