import { translate } from '@/i18n/i18n'
import type { ExecutionHostHealth } from '../../../shared/execution-host-health'
import type { RuntimeHostBlockedReason } from '../../../shared/runtime-host-status'
import type { RuntimeCompatVerdict } from '../../../shared/protocol-compat'

export function getExecutionHostHealthLabel(
  health: ExecutionHostHealth,
  blockedReason?: RuntimeHostBlockedReason
): string {
  switch (health) {
    case 'local':
      return translate('runtime.health.local', 'Local')
    case 'available':
      return translate('runtime.health.available', 'Connected')
    case 'connecting':
      return translate('runtime.health.connecting', 'Connecting')
    case 'disconnected':
      return translate('runtime.health.disconnected', 'Disconnected')
    case 'error':
      return translate('runtime.health.error', 'Needs attention')
    case 'blocked':
      return blockedReason === 'access-revoked'
        ? translate('runtime.health.repair', 'Re-pair needed')
        : translate('runtime.health.update', 'Update needed')
  }
}

export function describeRuntimeCompatBlock(verdict: RuntimeCompatVerdict): string {
  if (verdict.kind === 'ok') {
    return translate('runtime.compat.compatible', 'Runtime client and server are compatible.')
  }
  if (verdict.reason === 'client-too-old') {
    return translate(
      'runtime.compat.clientTooOld',
      'This Orca client is too old for the selected server. Update Orca on this machine. Client protocol {{clientProtocol}}, server requires client protocol {{requiredProtocol}}.',
      {
        clientProtocol: verdict.clientProtocolVersion,
        requiredProtocol: verdict.requiredClientProtocolVersion
      }
    )
  }
  return translate(
    'runtime.compat.serverTooOld',
    'The selected Orca server is too old for this client. Update Orca on the server. Server protocol {{serverProtocol}}, client requires server protocol {{requiredProtocol}}.',
    {
      serverProtocol: verdict.serverProtocolVersion,
      requiredProtocol: verdict.requiredServerProtocolVersion
    }
  )
}
