import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  TERMINAL_LIMIT_RUNTIME_CAPABILITY,
  type TerminalLimitStatus,
  type TerminalLimitUpdate
} from '../../../../shared/terminal-limit-policy'
import { callHostRoute } from '@/runtime/host-route-call'
import type { HostRoute } from '@/runtime/runtime-client-target'

export async function readTerminalLimit(
  route: HostRoute,
  signal: AbortSignal
): Promise<TerminalLimitStatus | null> {
  const host = await callHostRoute<RuntimeStatus>(route, 'status.get', undefined, { signal })
  if (!host.capabilities?.includes(TERMINAL_LIMIT_RUNTIME_CAPABILITY)) {
    return null
  }
  return callHostRoute(route, 'terminalDaemon.limit', undefined, { signal })
}

export function saveTerminalLimit(
  route: HostRoute,
  update: TerminalLimitUpdate,
  signal: AbortSignal
): Promise<TerminalLimitStatus | null> {
  return callHostRoute(route, 'terminalDaemon.setLimit', update, { signal })
}
