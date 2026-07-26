export const MOBILE_RELAY_STATUSES = [
  'connecting',
  'registered',
  'standby',
  'draining',
  'offline'
] as const

export type MobileRelayStatus = (typeof MOBILE_RELAY_STATUSES)[number]
