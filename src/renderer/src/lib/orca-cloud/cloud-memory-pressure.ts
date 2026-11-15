import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

/**
 * MEMGUARD: the sidebar row's memory mark. Only for a VM read as ready (a sleeping or unresponsive
 * one has its own state), and only when memory is short.
 */
export function cloudMemoryPressure(
  status: HostedWorkspaceStatus | null | undefined
): 'high' | 'critical' | null {
  if (status?.state !== 'ready') {
    return null
  }
  const pressure = status.memory?.pressure
  return pressure === 'high' || pressure === 'critical' ? pressure : null
}
