import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  evaluateRuntimeCompat,
  type RuntimeCompatVerdict
} from '../../../../../../shared/protocol-compat'
import { describeRuntimeCompatBlock } from '@/lib/runtime-host-copy'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../../shared/protocol-version'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../../../shared/worktree-runtime-capabilities'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../../shared/work-items/task-source-runtime-capabilities'
import type { RuntimeStatus } from '../../../../../../shared/runtime-session-contracts'
import '@/runtime/hosts/connections/runtime-host-connection-state'
import {
  runtimeHostConnectionState,
  type RuntimeHostConnectionState as RuntimeServerConnectionState
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'

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

export function getHostDetailsDescription(
  details: RuntimeHostDetails | undefined,
  t: Translate = translate
): string | null {
  if (!details || details.status === 'loading') {
    return null
  }
  if (details.status === 'error' && !isTransportConnected(details)) {
    return details.error
  }
  if (details.compatibility?.kind === 'blocked') {
    return describeRuntimeCompatBlock(details.compatibility, t)
  }
  if (details.runtimeStatus === null && details.compatibility === null) {
    const unavailableDescription = t(
      'auto.components.settings.RuntimeEnvironmentsPane.serverRuntimeUnavailableDescription',
      'SSH transport is connected, but the Orca runtime did not answer. The host may still be running.'
    )
    return details.error ? `${unavailableDescription} ${details.error}` : unavailableDescription
  }
  return null
}

export function getRuntimeCapabilitiesSummary(
  status: RuntimeStatus | null | undefined,
  t: Translate = translate
): string {
  const capabilities = status?.capabilities ?? []
  if (capabilities.length === 0) {
    return t(
      'auto.components.settings.RuntimeEnvironmentsPane.4b5c6d7e8f',
      'No capabilities reported'
    )
  }
  const visibleCapabilities = capabilities.slice(0, 3).join(', ')
  const hiddenCount = capabilities.length - 3
  return hiddenCount > 0 ? `${visibleCapabilities} +${hiddenCount}` : visibleCapabilities
}

export function getHostModelCapabilitySummary(
  status: RuntimeStatus | null | undefined,
  t: Translate = translate
): string | null {
  if (!status) {
    return null
  }
  const capabilities = status.capabilities
  if (!capabilities) {
    return t(
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
    return t(
      'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilitySupported',
      'Host model support: ready'
    )
  }
  const missingLabels = missing.map(getHostModelCapabilityLabel)
  return t(
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

export function getActiveServerModeDescription(
  allowLocalRuntime: boolean,
  t: Translate = translate
): string {
  return allowLocalRuntime
    ? t(
        'auto.components.settings.serverList.defaultHostHelp',
        'Existing projects stay where they are.'
      )
    : t(
        'auto.components.settings.serverList.defaultHostWebHelp',
        'This browser opens new projects on the chosen server.'
      )
}

export function isRuntimeEnvironmentRemovalBlocked(
  activeRuntimeEnvironmentId: string | null | undefined,
  environmentId: string
): boolean {
  return activeRuntimeEnvironmentId === environmentId
}

export function getRuntimeServerConnectionState(
  details: RuntimeHostDetails | undefined
): RuntimeServerConnectionState {
  if (!details || details.status === 'loading') {
    return 'checking'
  }
  if (details.compatibility?.kind === 'blocked') {
    return 'disconnected'
  }
  // Compatibility verdicts prove runtime availability even when older clients omit full status.
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
    // Ready details prove only transport; older/failed probes can omit runtime status, and errors need reachability diagnostics.
    transportStatus: details.status === 'ready' ? 'connected' : 'disconnected'
  })
}

export function getRuntimeServerConnectionLabel(
  state: RuntimeServerConnectionState,
  t: Translate = translate
): string {
  switch (state) {
    case 'connected':
      return t('auto.components.settings.RuntimeEnvironmentsPane.serverConnected', 'Connected')
    case 'runtime-unavailable':
      return t(
        'auto.components.settings.RuntimeEnvironmentsPane.serverRuntimeUnavailable',
        'Orca unavailable'
      )
    case 'workspace-window-closed':
      return t(
        'auto.components.settings.RuntimeEnvironmentsPane.serverWorkspaceWindowClosed',
        'Workspace window closed'
      )
    case 'reconnecting':
      return t(
        'auto.components.settings.RuntimeEnvironmentsPane.serverReconnecting',
        'Reconnecting'
      )
    case 'checking':
      return t('auto.components.settings.RuntimeEnvironmentsPane.serverChecking', 'Checking…')
    case 'disconnected':
      return t(
        'auto.components.settings.RuntimeEnvironmentsPane.serverDisconnected',
        'Disconnected'
      )
  }
}
