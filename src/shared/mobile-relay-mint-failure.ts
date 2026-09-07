/**
 * Structured failure when an Anywhere (Orca Relay) pairing mint cannot attach Relay.
 * Returned instead of silently degrading to a LAN-only QR under the Relay label.
 */
export type MobileRelayMintFailureStage =
  | 'provider_missing'
  | 'e2ee_missing'
  | 'binding_failed'
  | 'create_pairing_relay'

export type MobileRelayMintFailure = {
  code: string
  stage: MobileRelayMintFailureStage
  message: string
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
  return {
    code,
    stage: args.stage,
    message: args.fallbackMessage
  }
}
