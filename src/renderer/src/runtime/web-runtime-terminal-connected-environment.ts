import { translate } from '../i18n/i18n'
import { useAppStore } from '../store'
import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'
import { resolveWebRuntimeSessionEnvironmentId } from './web-runtime-session-workspace-routing'

/** The runtime environment a terminal create should talk to, or null when the workspace has no
 *  live pairing — the one condition that fails a create before anything is touched. */
export function resolveConnectedWebRuntimeEnvironmentId(
  requestedEnvironmentId: string | null | undefined
): string | null {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(
    requestedEnvironmentId,
    useAppStore.getState().settings?.activeRuntimeEnvironmentId
  )
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
