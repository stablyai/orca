// A user close's capability-gated params for session.tabs.close: `force` and the 'replay' mark go
// only to hosts that advertise them.
import type { RuntimeSessionTabCloseReason } from '../../../shared/runtime-types'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import {
  SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_REPLAY_REASON_RUNTIME_CAPABILITY
} from '../../../shared/session-tabs-runtime-capabilities'

export async function userTabCloseParams(
  environmentId: string,
  args: { reason?: RuntimeSessionTabCloseReason; force?: boolean; replay?: true }
): Promise<{ reason: RuntimeSessionTabCloseReason | 'replay' | undefined; force?: true }> {
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
  return { reason, ...(force ? { force: true } : {}) }
}
