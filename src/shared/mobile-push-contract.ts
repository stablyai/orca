// Why: the desktop host, the push gateway, and the phone must agree on these
// exact strings. See docs/reference/mobile-push-contract.md.

export const MOBILE_PUSH_SOURCES = ['agent-task-complete', 'terminal-bell', 'plugin'] as const
export type MobilePushSource = (typeof MOBILE_PUSH_SOURCES)[number]

// The only two states a phone can be told about; the host maps its richer
// agent status onto them before it ever reaches the gateway.
export const MOBILE_PUSH_AGENT_STATES = ['needs-input', 'finished'] as const
export type MobilePushAgentState = (typeof MOBILE_PUSH_AGENT_STATES)[number]

export const MOBILE_PUSH_PLATFORMS = ['ios', 'android'] as const
export type MobilePushPlatform = (typeof MOBILE_PUSH_PLATFORMS)[number]

export const MOBILE_PUSH_APNS_ENVIRONMENTS = ['sandbox', 'production'] as const
export type MobilePushApnsEnvironment = (typeof MOBILE_PUSH_APNS_ENVIRONMENTS)[number]

export type MobilePushFilter = {
  sources: readonly MobilePushSource[]
  agentStates: readonly MobilePushAgentState[]
}

/** Persisted on the paired DeviceEntry so a host restart can push without the phone re-registering. */
export type MobilePushRegistration = {
  registrationId: string
  platform: MobilePushPlatform
  filter: MobilePushFilter
  registeredAt: number
}

export type MobilePushRegisterInput = {
  deviceId: string
  platform: MobilePushPlatform
  token: string
  apnsEnvironment?: MobilePushApnsEnvironment
  filter: MobilePushFilter
}

export type MobilePushRegisterResult =
  | { registered: true; registrationId: string }
  | {
      registered: false
      // `registration_storage_failed`: the gateway accepted the token but the host
      // could not persist it, so the phone must register again rather than believe
      // a push route that does not exist.
      reason:
        | 'gateway_unreachable'
        | 'gateway_rejected'
        | 'not_mobile'
        | 'registration_storage_failed'
    }

function isStringMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
}

function parseFilter(value: unknown): MobilePushFilter | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const filter = value as Partial<MobilePushFilter>
  if (!Array.isArray(filter.sources) || !Array.isArray(filter.agentStates)) {
    return null
  }
  return {
    sources: filter.sources.filter((entry) => isStringMember(entry, MOBILE_PUSH_SOURCES)),
    agentStates: filter.agentStates.filter((entry) =>
      isStringMember(entry, MOBILE_PUSH_AGENT_STATES)
    )
  }
}

/**
 * Reads a persisted registration back. Returns undefined for anything an older or
 * corrupted registry may hold, so a bad row degrades to "this device has no push"
 * instead of failing the whole registry load.
 */
export function parseMobilePushRegistration(value: unknown): MobilePushRegistration | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const registration = value as Partial<MobilePushRegistration>
  const filter = parseFilter(registration.filter)
  if (
    typeof registration.registrationId !== 'string' ||
    registration.registrationId.length === 0 ||
    !isStringMember(registration.platform, MOBILE_PUSH_PLATFORMS) ||
    !filter ||
    typeof registration.registeredAt !== 'number' ||
    !Number.isFinite(registration.registeredAt)
  ) {
    return undefined
  }
  return {
    registrationId: registration.registrationId,
    platform: registration.platform,
    filter,
    registeredAt: registration.registeredAt
  }
}
