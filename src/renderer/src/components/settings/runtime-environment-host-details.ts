import { translate } from '@/i18n/i18n'
import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat,
  type RuntimeCompatVerdict
} from '../../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionState,
  type RuntimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'

export type RuntimeHostDetails = {
  status: 'loading' | 'ready' | 'error'
  runtimeStatus: RuntimeStatus | null
  /** Independent control-transport evidence when the status probe fails. */
  remoteControl?: RuntimeStatus['remoteControl'] | null
  compatibility: RuntimeCompatVerdict | null
  error: string | null
}

function isTransportConnected(details: RuntimeHostDetails): boolean {
  return details.remoteControl?.state === 'ready'
}

export function evaluateHostDetails(status: RuntimeStatus): RuntimeCompatVerdict {
  return evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
}

export function getHostDetailsSummary(details: RuntimeHostDetails | undefined): string {
  if (!details || details.status === 'loading') {
    return translate('auto.components.settings.RuntimeEnvironmentsPane.5120beaac6', 'Checking…')
  }
  if (details.status === 'error' && !isTransportConnected(details)) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.c8791efc45',
      'Status unavailable'
    )
  }
  if (details.runtimeStatus === null && details.compatibility === null) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.serverRuntimeUnavailable',
      'Orca unavailable'
    )
  }
  if (details.compatibility?.kind === 'blocked') {
    return details.compatibility.reason === 'client-too-old'
      ? translate('auto.components.settings.RuntimeEnvironmentsPane.62ac182a27', 'Update client')
      : translate('auto.components.settings.RuntimeEnvironmentsPane.86ed75bec8', 'Update server')
  }
  return translate('auto.components.settings.RuntimeEnvironmentsPane.9a91c4a0eb', 'Compatible')
}

export function getHostDetailsDescription(details: RuntimeHostDetails | undefined): string | null {
  if (!details || details.status === 'loading') {
    return null
  }
  if (details.status === 'error' && !isTransportConnected(details)) {
    return details.error
  }
  if (details.compatibility?.kind === 'blocked') {
    return describeRuntimeCompatBlock(details.compatibility)
  }
  if (details.runtimeStatus === null && details.compatibility === null) {
    const unavailableDescription = translate(
      'auto.components.settings.RuntimeEnvironmentsPane.serverRuntimeUnavailableDescription',
      'SSH transport is connected, but the Orca runtime did not answer. The host may still be running.'
    )
    return details.error ? `${unavailableDescription} ${details.error}` : unavailableDescription
  }
  return null
}

export function getRuntimeCapabilitiesSummary(status: RuntimeStatus | null | undefined): string {
  const capabilities = status?.capabilities ?? []
  if (capabilities.length === 0) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.4b5c6d7e8f',
      'No capabilities reported'
    )
  }
  const visibleCapabilities = capabilities.slice(0, 3).join(', ')
  const hiddenCount = capabilities.length - 3
  return hiddenCount > 0 ? `${visibleCapabilities} +${hiddenCount}` : visibleCapabilities
}

export function getHostModelCapabilitySummary(
  status: RuntimeStatus | null | undefined
): string | null {
  if (!status) {
    return null
  }
  const capabilities = status.capabilities
  if (!capabilities) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityUnknown',
      'Host model support: checking server capabilities'
    )
  }
  const missing = [
    PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
    TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
    WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
  ].filter((capability) => !capabilities.includes(capability))
  if (missing.length === 0) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilitySupported',
      'Host model support: ready'
    )
  }
  const missingLabels = missing.map(getHostModelCapabilityLabel)
  return translate(
    'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityMissing',
    'Host model support: update server for {{value0}}',
    { value0: missingLabels.join(', ') }
  )
}

function getHostModelCapabilityLabel(capability: string): string {
  switch (capability) {
    case PROJECT_HOST_SETUP_RUNTIME_CAPABILITY:
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityProjectSetup',
        'project setup'
      )
    case TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY:
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityTaskSourceContext',
        'task source context'
      )
    case WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY:
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityWorkspaceRunContext',
        'workspace run context'
      )
    default:
      return capability
  }
}

export function getActiveServerModeDescription(allowLocalRuntime: boolean): string {
  return allowLocalRuntime
    ? translate(
        'auto.components.settings.RuntimeEnvironmentsPane.3f67e8078a',
        'Use this computer by default. Choose a saved server only when you want supported projects, files, terminals, provider checks, and browser/mobile handoff to run through that server.'
      )
    : translate(
        'auto.components.settings.RuntimeEnvironmentsPane.2c85efb3e8',
        'Selecting a saved server makes this browser use that paired Orca runtime as its default Host.'
      )
}

export function isRuntimeEnvironmentRemovalBlocked(
  activeRuntimeEnvironmentId: string | null | undefined,
  environmentId: string
): boolean {
  return activeRuntimeEnvironmentId === environmentId
}

export type RuntimeServerConnectionState = RuntimeHostConnectionState

export function getRuntimeServerConnectionState(
  details: RuntimeHostDetails | undefined
): RuntimeServerConnectionState {
  if (!details || details.status === 'loading') {
    return 'checking'
  }
  if (details.compatibility?.kind === 'blocked') {
    return 'disconnected'
  }
  // A compatibility verdict is positive runtime evidence even when an older
  // client omitted the full status payload.
  if (
    details.status === 'ready' &&
    details.runtimeStatus === null &&
    details.compatibility !== null
  ) {
    return 'connected'
  }
  return runtimeHostConnectionState({
    hasStatusEntry: true,
    status: details.runtimeStatus,
    remoteControl: details.remoteControl,
    // A ready details phase is transport evidence only; status.get may still
    // have failed or been omitted by an older peer. Error details need
    // diagnostics to prove transport reachability.
    transportStatus: details.status === 'ready' ? 'connected' : 'disconnected'
  })
}

export function isRuntimeServerTransportConnected(state: RuntimeServerConnectionState): boolean {
  return isConnectedRuntimeHostState(state)
}

export function getRuntimeServerConnectionLabel(state: RuntimeServerConnectionState): string {
  switch (state) {
    case 'connected':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverConnected',
        'Connected'
      )
    case 'runtime-unavailable':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverRuntimeUnavailable',
        'Orca unavailable'
      )
    case 'workspace-window-closed':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverWorkspaceWindowClosed',
        'Workspace window closed'
      )
    case 'reconnecting':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverReconnecting',
        'Reconnecting'
      )
    case 'checking':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverChecking',
        'Checking…'
      )
    case 'disconnected':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverDisconnected',
        'Disconnected'
      )
  }
}

export function getRuntimeServerDotClass(state: RuntimeServerConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-emerald-500'
    case 'runtime-unavailable':
    case 'checking':
    case 'workspace-window-closed':
    case 'reconnecting':
      return 'bg-yellow-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}
