// Keep strings aligned across desktop, gateway and phone: cloud/packages/push-contract/src.

export const MOBILE_PUSH_SOURCES = ['agent-task-complete', 'terminal-bell', 'plugin'] as const
export type MobilePushSource = (typeof MOBILE_PUSH_SOURCES)[number]

// Host maps richer agent status onto these phone states before gateway submission.
export const MOBILE_PUSH_AGENT_STATES = ['needs-input', 'finished'] as const
export type MobilePushAgentState = (typeof MOBILE_PUSH_AGENT_STATES)[number]

export const MOBILE_PUSH_PLATFORMS = ['ios', 'android'] as const
export type MobilePushPlatform = (typeof MOBILE_PUSH_PLATFORMS)[number]

export const MOBILE_PUSH_APNS_ENVIRONMENTS = ['sandbox', 'production'] as const
export type MobilePushApnsEnvironment = (typeof MOBILE_PUSH_APNS_ENVIRONMENTS)[number]

// Why versioned: the phone names the envelope format it can open, so a later format
// can be added without an older phone receiving pushes it cannot read.
export const MOBILE_PUSH_SEALED_CONTENT_VERSIONS = ['e2e1'] as const
export type MobilePushSealedContentVersion = (typeof MOBILE_PUSH_SEALED_CONTENT_VERSIONS)[number]

export type MobilePushFilter = {
  onlyWhenDesktopAway?: boolean
  onlyWhenAgentNeedsInput?: boolean
  sound?: boolean
}

/** Persisted on the paired DeviceEntry so a host restart can push without the phone re-registering. */
export type MobilePushRegistration = {
  registrationId: string
  filter: MobilePushFilter
  expiresAt: number
  /** Absent for phones that predate sealed pushes; those keep receiving readable text. */
  sealedContent?: MobilePushSealedContentVersion
}

export type MobilePushRegisterInput = {
  deviceId: string
  platform: MobilePushPlatform
  token: string
  apnsEnvironment?: MobilePushApnsEnvironment
  filter: MobilePushFilter
  sealedContent?: MobilePushSealedContentVersion
}

export type MobilePushRegisterResult =
  | { registered: true; registrationId: string }
  | {
      registered: false
      // Storage failures require registration to be retried; throttling leaves the prior route intact.
      reason:
        | 'gateway_unreachable'
        | 'gateway_rejected'
        | 'not_mobile'
        | 'registration_storage_failed'
        | 'throttled'
    }

function parseFilter(value: unknown): MobilePushFilter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const filter = value as Partial<MobilePushFilter>
  if (
    (filter.onlyWhenDesktopAway !== undefined && typeof filter.onlyWhenDesktopAway !== 'boolean') ||
    (filter.onlyWhenAgentNeedsInput !== undefined &&
      typeof filter.onlyWhenAgentNeedsInput !== 'boolean') ||
    (filter.sound !== undefined && typeof filter.sound !== 'boolean')
  ) {
    return null
  }
  return {
    ...(typeof filter.onlyWhenDesktopAway === 'boolean'
      ? { onlyWhenDesktopAway: filter.onlyWhenDesktopAway }
      : {}),
    ...(typeof filter.onlyWhenAgentNeedsInput === 'boolean'
      ? { onlyWhenAgentNeedsInput: filter.onlyWhenAgentNeedsInput }
      : {}),
    ...(typeof filter.sound === 'boolean' ? { sound: filter.sound } : {})
  }
}

/** Invalid persisted registration means no push for this device, without failing the registry load. */
export function parseMobilePushRegistration(value: unknown): MobilePushRegistration | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const registration = value as Partial<MobilePushRegistration>
  const filter = parseFilter(registration.filter)
  if (
    typeof registration.registrationId !== 'string' ||
    registration.registrationId.length === 0 ||
    !filter ||
    typeof registration.expiresAt !== 'number' ||
    !Number.isFinite(registration.expiresAt)
  ) {
    return undefined
  }
  return {
    registrationId: registration.registrationId,
    filter,
    expiresAt: registration.expiresAt,
    // An unknown version degrades to readable pushes rather than dropping the registration.
    ...(MOBILE_PUSH_SEALED_CONTENT_VERSIONS.some(
      (version) => version === registration.sealedContent
    )
      ? { sealedContent: registration.sealedContent }
      : {})
  }
}

export type MobilePushTestResult =
  | { accepted: true }
  | { accepted: false; reason: 'not_registered' | 'unavailable' | 'rate_limited' | 'rejected' }
