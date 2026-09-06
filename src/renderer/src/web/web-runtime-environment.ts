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

export type StoredWebRuntimeEnvironments = {
  environments: StoredWebRuntimeEnvironment[]
  activeEnvironmentId: string | null
}

const ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'
const ENVIRONMENTS_STORAGE_KEY = 'orca.web.runtimeEnvironments.v2'

// Per-entry validation shared by v1 and v2 reads
function parseStoredWebRuntimeEnvironment(raw: string): StoredWebRuntimeEnvironment | null {
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
    const {
      compatibleEnvironmentIds: _unvalidatedIds,
      pairedDeviceId: _unvalidatedDeviceId,
      ...environment
    } = parsed
    return {
      ...environment,
      ...(pairedDeviceId ? { pairedDeviceId } : {}),
      ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {})
    }
  } catch {
    return null
  }
}

function writeStoredWebRuntimeEnvironments(state: StoredWebRuntimeEnvironments): void {
  if (state.environments.length === 0) {
    window.localStorage.removeItem(ENVIRONMENTS_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify(state))
}

export function readStoredWebRuntimeEnvironments(): StoredWebRuntimeEnvironments {
  const rawV2 = window.localStorage.getItem(ENVIRONMENTS_STORAGE_KEY)
  if (!rawV2) {
    return migrateLegacyStoredWebRuntimeEnvironment()
  }
  const empty: StoredWebRuntimeEnvironments = { environments: [], activeEnvironmentId: null }
  try {
    const parsed = JSON.parse(rawV2) as StoredWebRuntimeEnvironments
    if (!Array.isArray(parsed.environments)) {
      return empty
    }
    const environments = parsed.environments
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => parseStoredWebRuntimeEnvironment(JSON.stringify(entry)))
      .filter((entry): entry is StoredWebRuntimeEnvironment => entry !== null)
    const byId = new Map(environments.map((entry) => [entry.id, entry]))
    let activeEnvironmentId =
      typeof parsed.activeEnvironmentId === 'string' && byId.has(parsed.activeEnvironmentId)
        ? parsed.activeEnvironmentId
        : null
    if (activeEnvironmentId === null && environments.length > 0) {
      // Stale active id falls back to the first entry and the fix is persisted
      activeEnvironmentId = environments[0].id
      writeStoredWebRuntimeEnvironments({ environments, activeEnvironmentId })
    }
    return { environments, activeEnvironmentId }
  } catch {
    return empty
  }
}

function migrateLegacyStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironments {
  const empty: StoredWebRuntimeEnvironments = { environments: [], activeEnvironmentId: null }
  const rawV1 = window.localStorage.getItem(ENVIRONMENT_STORAGE_KEY)
  if (!rawV1) {
    return empty
  }
  window.localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
  const environment = parseStoredWebRuntimeEnvironment(rawV1)
  if (!environment) {
    return empty
  }
  const state: StoredWebRuntimeEnvironments = {
    environments: [environment],
    activeEnvironmentId: environment.id
  }
  writeStoredWebRuntimeEnvironments(state)
  return state
}

export function readStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  const state = readStoredWebRuntimeEnvironments()
  return state.environments.find((entry) => entry.id === state.activeEnvironmentId) ?? null
}

export function saveStoredWebRuntimeEnvironment(environment: StoredWebRuntimeEnvironment): void {
  const state = readStoredWebRuntimeEnvironments()
  const existingIndex = state.environments.findIndex((entry) => entry.id === environment.id)
  const environments =
    existingIndex !== -1
      ? state.environments.map((entry, index) => (index === existingIndex ? environment : entry))
      : [...state.environments, environment]
  writeStoredWebRuntimeEnvironments({
    environments,
    activeEnvironmentId: state.activeEnvironmentId ?? environment.id
  })
}

export function saveStoredWebRuntimeEnvironments(state: StoredWebRuntimeEnvironments): void {
  writeStoredWebRuntimeEnvironments(state)
}

export function clearStoredWebRuntimeEnvironment(): void {
  const state = readStoredWebRuntimeEnvironments()
  if (!state.activeEnvironmentId) {
    return
  }
  const environments = state.environments.filter((entry) => entry.id !== state.activeEnvironmentId)
  writeStoredWebRuntimeEnvironments({
    environments,
    activeEnvironmentId: environments[0]?.id ?? null
  })
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
  previousEnvironment?: StoredWebRuntimeEnvironment | null
  connectionDependency?: 'ssh-tunnel'
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
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
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
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
  }
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
