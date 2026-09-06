// The pure acquisition gate for an OMP RPC chat pane.
//
// Split out of use-omp-rpc-chat-pane-ownership.ts because that module sits at the
// 300-line budget and the max-lines ratchet requires new growth to move into a
// sibling rather than take a bypass. Kept re-exported from the hook module so the
// gate and the lifecycle that consumes it stay one import surface.

import type { AgentType } from '../../../../shared/agent-status-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'
import { canOwnOmpRpcSessionLocally, resolveOmpRpcPaneExecutionHost } from './omp-rpc-pane-locality'

/** Visible, OMP, executing on THIS client, a paneKey, and a known cwd/session
 *  identity. Exported pure so the acquisition gate is unit-testable without
 *  mounting the hook.
 *
 *  Locality is resolved from the pane's execution host, not from
 *  `runtimeEnvironmentId` alone: that id is null for an `ssh:` worktree too, so
 *  the old proxy admitted a Model-A SSH pane and let acquisition kill a remote
 *  PTY and scan this client's disk for a remote cwd
 *  (docs/reference/ssh-execution-boundary.md, rule 1). An unresolved owner is
 *  refused for the same reason — it is not evidence of local.
 *
 *  Standing rule (wave 9, Defect 1): `ptyId` is deliberately NOT one of
 *  these gates. Decision 1's acquisition kills the pane's live PTY on
 *  success, so requiring `ptyId !== null` here would make the hook's own
 *  success flip this eligible->false and tear the just-acquired ownership
 *  back down — the exact deadlock this wave fixes. `ptyId` is consumed
 *  only as an input to the acquire call itself, never as a precondition
 *  for staying eligible. */
export function isOmpRpcChatSessionEligible(args: {
  agent: AgentType | null
  isVisible: boolean
  runtimeEnvironmentId: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
  connectionId: string | null | undefined
  paneKey: string | null
  cwd: string | null
  sessionFile: string | null
}): boolean {
  return (
    args.isVisible &&
    isOmpRpcCatalogAgent(args.agent) &&
    canOwnOmpRpcSessionLocally(
      resolveOmpRpcPaneExecutionHost({
        runtimeEnvironmentId: args.runtimeEnvironmentId,
        projectRuntime: args.projectRuntime,
        connectionId: args.connectionId
      })
    ) &&
    args.paneKey !== null &&
    args.cwd !== null &&
    args.sessionFile !== null
  )
}
