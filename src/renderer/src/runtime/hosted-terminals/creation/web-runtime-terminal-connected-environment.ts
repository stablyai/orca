import { translate } from '@/i18n/i18n'
import type { WebRuntimeTerminalCreateOutcome } from './terminal-create-contracts'
import { isWebRuntimeSessionActive } from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { resolveWebRuntimeSessionEnvironmentId } from '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-routing'

/** The runtime environment a terminal create should talk to, or null when the workspace has no
 *  live pairing — the one condition that fails a create before anything is touched. */
export function resolveConnectedWebRuntimeEnvironmentId(
  requestedEnvironmentId: string | null | undefined
): string | null {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(requestedEnvironmentId, null)
  return environmentId && isWebRuntimeSessionActive(environmentId) ? environmentId : null
}

export function disconnectedWebRuntimeTerminalOutcome(): WebRuntimeTerminalCreateOutcome {
  return {
    status: 'failed',
    message: translate(
      'auto.runtime.webRuntimeSession.remoteHostDisconnected',
      'The workspace is not connected to a remote Orca host.'
    )
  }
}
