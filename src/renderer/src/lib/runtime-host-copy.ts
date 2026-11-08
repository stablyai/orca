import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostHealth } from '../../../shared/execution-host/execution-host-health'
import type { RuntimeHostBlockedReason } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeCompatVerdict } from '../../../shared/protocol-compat'

export function getExecutionHostHealthLabel(
  health: ExecutionHostHealth,
  blockedReason?: RuntimeHostBlockedReason,
  t: Translate = translate
): string {
  switch (health) {
    case 'local':
      return t('runtime.health.local', 'Local')
    case 'available':
      return t('runtime.health.available', 'Connected')
    case 'connecting':
      return t('runtime.health.connecting', 'Connecting')
    case 'disconnected':
      return t('runtime.health.disconnected', 'Disconnected')
    case 'error':
      return t('runtime.health.error', 'Needs attention')
    case 'blocked':
      return blockedReason === 'access-revoked'
        ? t('runtime.health.repair', 'Re-pair needed')
        : blockedReason === 'server-replaced'
          ? t('runtime.health.serverReplaced', 'Different server')
          : t('runtime.health.update', 'Update needed')
  }
}

export function describeRuntimeCompatBlock(
  verdict: RuntimeCompatVerdict,
  t: Translate = translate
): string {
  if (verdict.kind === 'ok') {
    return t('runtime.compat.compatible', 'Runtime client and server are compatible.')
  }
  if (verdict.reason === 'client-too-old') {
    return t(
      'runtime.compat.clientTooOld',
      'This Orca client is too old for the selected server. Update Orca on this machine. Client protocol {{clientProtocol}}, server requires client protocol {{requiredProtocol}}.',
      {
        clientProtocol: verdict.clientProtocolVersion,
        requiredProtocol: verdict.requiredClientProtocolVersion
      }
    )
  }
  return t(
    'runtime.compat.serverTooOld',
    'The selected Orca server is too old for this client. Update Orca on the server. Server protocol {{serverProtocol}}, client requires server protocol {{requiredProtocol}}.',
    {
      serverProtocol: verdict.serverProtocolVersion,
      requiredProtocol: verdict.requiredServerProtocolVersion
    }
  )
}
