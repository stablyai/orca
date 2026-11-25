// What a bot host's Orca can do, read from the host statuses alone so store slices can ask too.
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import {
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { BOTS_HOME_PIN_RUNTIME_CAPABILITY } from '../../../shared/bot-runtime-capabilities'

/** A paired server's last verified status; null for this app's own runtime, or before it is known. */
export function pairedBotHostStatus(
  hostId: ExecutionHostId,
  statuses: RuntimeStatuses
): RuntimeStatus | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime') {
    return null
  }
  return lastVerifiedRuntimeStatus(statuses.get(parsed.environmentId)) ?? null
}

/** Whether the host's Orca has `capability`; this app's own runtime is this build, so it does. */
export function botHostHasCapability(
  hostId: ExecutionHostId,
  capability: string,
  statuses: RuntimeStatuses
): boolean {
  return (
    parseRoutableExecutionHostId(hostId)?.kind === 'local' ||
    pairedBotHostStatus(hostId, statuses)?.capabilities?.includes(capability) === true
  )
}

/** Whether `bot`'s host keeps its Home pinned first; an older paired server leaves its pages as they were. */
export function botHomeRuleApplies(
  bot: { hostId: ExecutionHostId } | null,
  statuses: RuntimeStatuses
): boolean {
  return (
    bot !== null && botHostHasCapability(bot.hostId, BOTS_HOME_PIN_RUNTIME_CAPABILITY, statuses)
  )
}
