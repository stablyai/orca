import { isTailscaleEndpoint } from './remote-runtime-tailscale-hint'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'

export type RuntimeEndpointTransportKind = 'tailscale' | 'direct'

export function getPreferredPublicRuntimeEndpoint(
  environment: Pick<PublicKnownRuntimeEnvironment, 'endpoints' | 'preferredEndpointId'>
): string | null {
  const preferred =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  return preferred?.endpoint?.trim() || null
}

export function getRuntimeEndpointTransportKind(
  endpoint: string | null | undefined
): RuntimeEndpointTransportKind {
  return isTailscaleEndpoint(endpoint) ? 'tailscale' : 'direct'
}
