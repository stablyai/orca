import type { RuntimeEndpointTransportKind } from '../../../../shared/runtime-environment-endpoint-display'
import { translate } from '@/i18n/i18n'

export function getRuntimeEndpointTransportLabel(kind: RuntimeEndpointTransportKind): string {
  return kind === 'tailscale'
    ? translate(
        'auto.components.settings.RuntimeEnvironmentsPane.endpointTransportTailscale',
        'Tailscale'
      )
    : translate(
        'auto.components.settings.RuntimeEnvironmentsPane.endpointTransportDirect',
        'Direct'
      )
}

export function getRuntimeServerEndpointDisplay(endpoint: string | null): string {
  return (
    endpoint ??
    translate('auto.components.settings.RuntimeEnvironmentsPane.6ef71985da', 'No endpoint')
  )
}
