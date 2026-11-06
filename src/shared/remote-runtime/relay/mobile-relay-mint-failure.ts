/** Anywhere mint failure; never silently replace the Relay offer with a LAN-only QR. */
export type MobileRelayMintFailureStage =
  | 'provider_missing'
  | 'e2ee_missing'
  | 'binding_failed'
  | 'create_pairing_relay'

export type MobileRelayMintFailure = {
  code: string
  stage: MobileRelayMintFailureStage
  message: string
  clockOffsetMs?: number
}

export function mobileRelayMintFailureFromUnknown(args: {
  stage: MobileRelayMintFailureStage
  error: unknown
  fallbackCode: string
  fallbackMessage: string
}): MobileRelayMintFailure {
  const candidateCode =
    typeof args.error === 'object' &&
    args.error !== null &&
    'code' in args.error &&
    typeof args.error.code === 'string'
      ? args.error.code
      : args.error instanceof Error
        ? args.error.message
        : null
  const code =
    candidateCode != null && /^relay_[a-z0-9_]{1,74}$/.test(candidateCode)
      ? candidateCode
      : args.fallbackCode
  const clockOffsetMs =
    code === 'relay_clock_skew' &&
    typeof args.error === 'object' &&
    args.error !== null &&
    'clockOffsetMs' in args.error &&
    typeof args.error.clockOffsetMs === 'number' &&
    Number.isFinite(args.error.clockOffsetMs)
      ? args.error.clockOffsetMs
      : undefined
  return {
    code,
    stage: args.stage,
    message: args.fallbackMessage,
    ...(clockOffsetMs === undefined ? {} : { clockOffsetMs })
  }
}
