import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type GitRuntimeOperationOptions = {
  /** The worktree owner's transport; absent resolves it from the worktree's rows. */
  runtimeTarget?: RuntimeClientTarget | null
  applyUpstreamStatus?: boolean
  /** A safety tick's read: no use of an idle WSL host (#46567). */
  background?: boolean
}
