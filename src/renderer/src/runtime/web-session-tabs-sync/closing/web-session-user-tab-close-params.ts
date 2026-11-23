// Send force/replay close params only to advertising hosts.
import type { RuntimeSessionTabCloseReason } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import {
  SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_TERMINALS_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_REPLAY_REASON_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'

export async function userTabCloseParams(
  environmentId: string,
  args: {
    reason?: RuntimeSessionTabCloseReason
    force?: boolean
    replay?: true
    terminals?: string[]
  }
): Promise<{
  params: {
    reason: RuntimeSessionTabCloseReason | 'replay' | undefined
    force?: true
    terminals?: string[]
  }
  /** The user approved specific terminals but the host cannot hold the close to them. */
  approvalUnhonored: boolean
}> {
  // Why gated: an older host strips `force` and refuses the pinned tab exactly as before.
  const force =
    args.force === true &&
    (await runtimeEnvironmentSupportsCapability(
      environmentId,
      SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY
    ))
  // Only a user close carries `replay`. The mark is diagnostic, so an unanswered probe sends 'user'.
  const reason =
    args.replay === true &&
    (await runtimeEnvironmentSupportsCapability(
      environmentId,
      SESSION_TAB_CLOSE_REPLAY_REASON_RUNTIME_CAPABILITY
    ).catch(() => false))
      ? 'replay'
      : args.reason
  const approved = args.terminals !== undefined ? args.terminals : null
  // Let network/timeout errors propagate so offline closes are held for replay instead of misclassified as old hosts.
  const approvalHonored =
    approved === null ||
    (await runtimeEnvironmentSupportsCapability(
      environmentId,
      SESSION_TAB_CLOSE_TERMINALS_RUNTIME_CAPABILITY
    ))
  return {
    params: {
      reason,
      ...(force ? { force: true as const } : {}),
      ...(approved !== null && approvalHonored ? { terminals: approved } : {})
    },
    approvalUnhonored: !approvalHonored
  }
}
