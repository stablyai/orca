export const MOBILE_RELAY_CLOSE_CODE = {
  BAD_OUTER_CREDENTIAL: 4401,
  HOST_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  WRONG_CELL: 4409,
  LIMIT_EXCEEDED: 4429,
  DRAINING: 4503
} as const

export type MobileRelayCloseCode =
  (typeof MOBILE_RELAY_CLOSE_CODE)[keyof typeof MOBILE_RELAY_CLOSE_CODE]
export type MobileRelayLeg = 'host-control' | 'host-data' | 'phone-invite' | 'phone-resume'

export type MobileRelayRecovery =
  | { kind: 'disable-relay-credential'; directUnaffected: true }
  | { kind: 'wait-for-host-revival' }
  | { kind: 'reconnect-fresh-e2ee'; fullJitter: true }
  | { kind: 'resolve-invite-through-director-ws'; requireStrictlyNewerEpoch: true }
  | { kind: 'resolve-resume-through-director-post' }
  | { kind: 'request-director-assignment' }
  | { kind: 'backoff'; fullJitter: true }
  | { kind: 'resolve-configured-director'; fullJitter: true }

export function mobileRelayRecoveryFor(
  code: MobileRelayCloseCode,
  leg: MobileRelayLeg
): MobileRelayRecovery {
  switch (code) {
    case MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL:
      return { kind: 'disable-relay-credential', directUnaffected: true }
    case MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE:
      return { kind: 'wait-for-host-revival' }
    case MOBILE_RELAY_CLOSE_CODE.PEER_DROPPED:
      return { kind: 'reconnect-fresh-e2ee', fullJitter: true }
    case MOBILE_RELAY_CLOSE_CODE.WRONG_CELL:
      if (leg === 'phone-invite') {
        return { kind: 'resolve-invite-through-director-ws', requireStrictlyNewerEpoch: true }
      }
      return leg === 'phone-resume'
        ? { kind: 'resolve-resume-through-director-post' }
        : { kind: 'request-director-assignment' }
    case MOBILE_RELAY_CLOSE_CODE.LIMIT_EXCEEDED:
      return { kind: 'backoff', fullJitter: true }
    case MOBILE_RELAY_CLOSE_CODE.DRAINING:
      return { kind: 'resolve-configured-director', fullJitter: true }
  }
}

export function isMobileRelayCloseCode(value: number): value is MobileRelayCloseCode {
  return Object.values(MOBILE_RELAY_CLOSE_CODE).some((code) => code === value)
}
