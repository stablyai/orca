// Which host actually executes an OMP chat pane's `omp` process. RPC ownership
// spawns that process on THIS client, so it may only ever be offered to a pane
// whose execution host is this client — docs/reference/ssh-execution-boundary.md
// rule 1: an operation on a remote path must never fall back to running locally,
// because a local run can answer for the wrong repository.
//
// Replaces the `runtimeEnvironmentId === null` proxy the ownership path used to
// gate on. That proxy is a runtime-OWNER test, not a locality test:
// `selectNativeChatRuntimeEnvironmentId` returns null for an `ssh:` worktree, so
// a Model-A SSH pane read as local and reached the local session-file scan with
// a remote cwd.

import { isWebClientLocation } from '@/lib/web-client-location'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'

/** `unresolved` is its own verdict, never a synonym for `local`: the store has
 *  not yet said who owns the pane's worktree, and "we could not ask" is not
 *  evidence that the answer is this machine. */
export type OmpRpcPaneExecutionHost = 'local' | 'ssh' | 'runtime' | 'wsl' | 'unresolved'

export type OmpRpcPaneLocalityInput = {
  /** Model-B runtime owner for the pane's worktree, or null. */
  runtimeEnvironmentId: string | null
  /** SSH target owning the pane's worktree: null = this client, a target id =
   *  a remote host, undefined = the backing repo has not hydrated yet. */
  connectionId: string | null | undefined
  /** A local Windows project's resolved runtime. WSL runs on this machine but
   * is still a different OMP process/session namespace from the host. */
  projectRuntime?: ProjectExecutionRuntimeResolution
  /** Defaults to the real probe; injected by tests and by callers that already
   *  resolved it. */
  isWebClient?: boolean
}

export function resolveOmpRpcPaneExecutionHost(
  input: OmpRpcPaneLocalityInput
): OmpRpcPaneExecutionHost {
  // The web client never executes anything itself — its `window.api` is a
  // bridge to the paired runtime, which owns every process (same boundary
  // getNativeChatSessionTransport's KTD-2 check draws).
  if (input.isWebClient ?? isWebClientLocation()) {
    return 'runtime'
  }
  if (input.runtimeEnvironmentId !== null) {
    return 'runtime'
  }
  if (input.projectRuntime?.status === 'resolved' && input.projectRuntime.runtime.kind === 'wsl') {
    return 'wsl'
  }
  if (input.connectionId === undefined) {
    return 'unresolved'
  }
  if (input.connectionId === null) {
    return 'local'
  }
  // A runtime-owned SSH target is Model B reached over ssh: the runtime, not
  // this client, drives the host.
  return isRuntimeOwnedSshTargetId(input.connectionId) ? 'runtime' : 'ssh'
}

export function canOwnOmpRpcSessionLocally(host: OmpRpcPaneExecutionHost): boolean {
  return host === 'local'
}
