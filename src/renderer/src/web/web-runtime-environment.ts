import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WebPairingOffer } from './web-pairing'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export type StoredWebRuntimeEnvironment = Omit<PublicKnownRuntimeEnvironment, 'endpoints'> & {
  compatibleEnvironmentIds?: string[]
  endpoints: {
    id: string
    kind: 'websocket'
    label: string
    endpoint: string
    deviceToken: string
    publicKeyB64: string
  }[]
}

const ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

export function readStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  const raw = window.localStorage.getItem(ENVIRONMENT_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as StoredWebRuntimeEnvironment
    if (
      !parsed.id ||
      !parsed.name ||
      !Array.isArray(parsed.endpoints) ||
      parsed.endpoints.length === 0
    ) {
      return null
    }
    const compatibleEnvironmentIds = Array.isArray(parsed.compatibleEnvironmentIds)
      ? parsed.compatibleEnvironmentIds.filter(
          (environmentId): environmentId is string => typeof environmentId === 'string'
        )
      : []
    const { compatibleEnvironmentIds: _unvalidatedIds, ...environment } = parsed
    return {
      ...environment,
      ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {})
    }
  } catch {
    return null
  }
}

export function saveStoredWebRuntimeEnvironment(environment: StoredWebRuntimeEnvironment): void {
  window.localStorage.setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(environment))
}

export function clearStoredWebRuntimeEnvironment(): void {
  window.localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
  previousEnvironment?: StoredWebRuntimeEnvironment | null
}): StoredWebRuntimeEnvironment {
  const id = `web-${createBrowserUuid()}`
  const now = Date.now()
  const compatibleEnvironmentIds = getCompatibleEnvironmentIds(args.previousEnvironment, args.offer)
  return {
    id,
    name: args.name.trim() || 'Orca Server',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    runtimeId: null,
    ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {}),
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: translate('auto.web.web.runtime.environment.07f788de83', 'WebSocket'),
        endpoint: args.offer.endpoint,
        deviceToken: args.offer.deviceToken,
        publicKeyB64: args.offer.publicKeyB64
      }
    ]
  }
}

function getCompatibleEnvironmentIds(
  previous: StoredWebRuntimeEnvironment | null | undefined,
  offer: WebPairingOffer
): string[] {
  if (!previous?.endpoints.some((endpoint) => endpoint.publicKeyB64 === offer.publicKeyB64)) {
    return []
  }
  return [...new Set([...(previous.compatibleEnvironmentIds ?? []), previous.id])]
}

export function redactStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const { compatibleEnvironmentIds: _compatibleEnvironmentIds, ...publicEnvironment } = environment
  return {
    ...publicEnvironment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _token, publicKeyB64: _key, ...rest }) => ({
        ...rest
      })
    )
  }
}

export function getPreferredWebPairingOffer(
  environment: StoredWebRuntimeEnvironment
): WebPairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  return {
    v: 2,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64
  }
}

export function updateStoredEnvironmentRuntimeId(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string | null
): StoredWebRuntimeEnvironment {
  const next = {
    ...environment,
    runtimeId,
    updatedAt: Date.now(),
    lastUsedAt: Date.now()
  }
  saveStoredWebRuntimeEnvironment(next)
  return next
}

export function isMixedContentWebSocket(endpoint: string): boolean {
  return window.location.protocol === 'https:' && endpoint.startsWith('ws://')
}
