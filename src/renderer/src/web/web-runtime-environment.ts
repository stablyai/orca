import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../../shared/paired-runtime-connection'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  RuntimeHostDescriptorSchema,
  type RuntimeHostDescriptor
} from '../../../shared/runtime-host-descriptor'
import { classifyRuntimeHostRePair } from '../../../shared/runtime-host-pairing-identity'
import type { WebPairingOffer } from './web-pairing'
import { readWebDeviceKeySupport } from './web-device-key-support'
import { MIGRATED_DEVICE_TOKEN_PREFIX } from './web-runtime-credential-source'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export type StoredWebRuntimeEnvironment = Omit<PublicKnownRuntimeEnvironment, 'endpoints'> & {
  /** Ids minted by re-pairs before re-pairing kept the id; read-only, never extended. */
  compatibleEnvironmentIds?: string[]
  /** The server's descriptor pinned at pairing; see classifyRuntimeHostRePair. */
  hostDescriptor?: RuntimeHostDescriptor
  /** Paired where no key can be persisted: kept in memory only, never in localStorage. */
  sessionOnly?: true
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

// Why memory: a session-only pairing's code must not outlive the page (#17399).
let sessionEnvironment: StoredWebRuntimeEnvironment | null = null

export function readStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  if (sessionEnvironment) {
    return sessionEnvironment
  }
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
    const pairedDeviceId =
      typeof parsed.pairedDeviceId === 'string' && parsed.pairedDeviceId.trim().length > 0
        ? parsed.pairedDeviceId.trim()
        : null
    const hostDescriptor = RuntimeHostDescriptorSchema.safeParse(parsed.hostDescriptor).data
    const {
      compatibleEnvironmentIds: _unvalidatedIds,
      pairedDeviceId: _unvalidatedDeviceId,
      hostDescriptor: _unvalidatedDescriptor,
      ...environment
    } = parsed
    return {
      ...environment,
      ...(pairedDeviceId ? { pairedDeviceId } : {}),
      ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {}),
      ...(hostDescriptor ? { hostDescriptor } : {})
    }
  } catch {
    return null
  }
}

export function saveStoredWebRuntimeEnvironment(environment: StoredWebRuntimeEnvironment): void {
  if (environment.sessionOnly) {
    sessionEnvironment = environment
    // Why: a new session pairing replaces whatever older pairing (and its code) was stored.
    window.localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
    return
  }
  sessionEnvironment = null
  const stored = readStoredWebRuntimeEnvironment()
  // Why: a stale tab must not roll back another tab's re-pair of the same environment.
  if (stored?.id === environment.id && pairingRevision(stored) > pairingRevision(environment)) {
    return
  }
  window.localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify(keepMigratedPlaceholders(environment, stored))
  )
}

// Stale tabs must retain another tab’s migrated placeholder; only re-pair’s new revision may store a fresh code.
function keepMigratedPlaceholders(
  next: StoredWebRuntimeEnvironment,
  stored: StoredWebRuntimeEnvironment | null
): StoredWebRuntimeEnvironment {
  if (!stored || stored.id !== next.id || pairingRevision(stored) !== pairingRevision(next)) {
    return next
  }
  return {
    ...next,
    endpoints: next.endpoints.map((endpoint) => {
      const storedToken = stored.endpoints.find((entry) => entry.id === endpoint.id)?.deviceToken
      return storedToken?.startsWith(MIGRATED_DEVICE_TOKEN_PREFIX)
        ? { ...endpoint, deviceToken: storedToken }
        : endpoint
    })
  }
}

function pairingRevision(environment: StoredWebRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

export function clearStoredWebRuntimeEnvironment(): void {
  sessionEnvironment = null
  window.localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
  previousEnvironment?: StoredWebRuntimeEnvironment | null
  connectionDependency?: 'ssh-tunnel'
}): StoredWebRuntimeEnvironment {
  const previous = args.previousEnvironment
  const match = previous
    ? classifyRuntimeHostRePair(
        {
          publicKeys: previous.endpoints.map((endpoint) => endpoint.publicKeyB64),
          pin: previous.hostDescriptor
        },
        args.offer
      )
    : { kind: 'different-host' as const }
  // Why keep the id: it is this server's execution-host identity; a new one strands its sessions (#11574).
  const sameHost = match.kind === 'same-host' ? previous : null
  const id = sameHost?.id ?? `web-${createBrowserUuid()}`
  const now = Date.now()
  const pin = match.kind === 'same-host' ? match.pin : args.offer.hostDescriptor
  const compatibleEnvironmentIds = sameHost?.compatibleEnvironmentIds ?? []
  return {
    id,
    name: args.name.trim() || 'Orca Server',
    createdAt: sameHost?.createdAt ?? now,
    updatedAt: now,
    // Why bump: request fences compare revisions, and the device token they captured is gone.
    ...(sameHost
      ? { pairingRevision: Math.max(now, (sameHost.pairingRevision ?? sameHost.createdAt) + 1) }
      : {}),
    lastUsedAt: null,
    runtimeId: null,
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
    ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {}),
    ...(pin ? { hostDescriptor: pin } : {}),
    ...(isSessionOnlyBrowser() ? { sessionOnly: true as const } : {}),
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

export function redactStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const {
    compatibleEnvironmentIds: _compatibleEnvironmentIds,
    hostDescriptor: _hostDescriptor,
    sessionOnly: _sessionOnly,
    ...publicEnvironment
  } = environment
  return {
    ...publicEnvironment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _token, publicKeyB64: _key, ...rest }) => ({
        ...rest
      })
    )
  }
}

export function getPreferredWebRuntimeConnection(
  environment: StoredWebRuntimeEnvironment
): PairedRuntimeConnection {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  return pairedRuntimeConnectionFromOffer({
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    pairedDeviceId: environment.pairedDeviceId
  })
}

export function updateStoredEnvironmentRuntimeId(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string | null,
  pairedDeviceId?: string
): StoredWebRuntimeEnvironment {
  const next = {
    ...environment,
    runtimeId,
    ...(pairedDeviceId ? { pairedDeviceId } : {}),
    updatedAt: Date.now(),
    lastUsedAt: Date.now()
  }
  saveStoredWebRuntimeEnvironment(next)
  return next
}

export function isMixedContentWebSocket(endpoint: string): boolean {
  return window.location.protocol === 'https:' && endpoint.startsWith('ws://')
}

/** Forget the pairing code once a device key replaced it; the pairing itself is unchanged. */
export function replaceStoredTokenWithDeviceKey(
  environment: StoredWebRuntimeEnvironment,
  deviceId: string
): StoredWebRuntimeEnvironment {
  const next = {
    ...environment,
    endpoints: environment.endpoints.map((endpoint) => ({
      ...endpoint,
      deviceToken: `${MIGRATED_DEVICE_TOKEN_PREFIX}${deviceId}`
    }))
  }
  saveStoredWebRuntimeEnvironment(next)
  return next
}

function isSessionOnlyBrowser(): boolean {
  const support = readWebDeviceKeySupport()
  return support === 'session-no-ed25519'
}
