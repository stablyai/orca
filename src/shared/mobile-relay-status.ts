export const MOBILE_RELAY_STATUSES = ['connecting', 'registered', 'draining', 'offline'] as const

export type MobileRelayStatus = (typeof MOBILE_RELAY_STATUSES)[number]
