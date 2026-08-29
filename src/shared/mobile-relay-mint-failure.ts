import { errorOwnDataProperty } from './error-own-data-property'
import { networkTransportErrorCode } from './network-transport-error-code'

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
  // Why: a relay_* code names the mint step that failed, not the transport reason underneath it.
  networkCode?: string
}

export function mobileRelayMintFailureFromUnknown(args: {
  stage: MobileRelayMintFailureStage
  error: unknown
  fallbackCode: string
  fallbackMessage: string
}): MobileRelayMintFailure {
  // Why descriptor reads: this runs inside a catch block, so a malformed error must not throw
  // again here. `message` stands in for the old `instanceof Error` branch — the pattern below
  // is what actually decides whether a value is admitted.
  const errorCode = errorOwnDataProperty(args.error, 'code')
  const errorMessage = errorOwnDataProperty(args.error, 'message')
  const candidateCode =
    typeof errorCode === 'string'
      ? errorCode
      : typeof errorMessage === 'string'
        ? errorMessage
        : null
  const code =
    candidateCode != null && /^relay_[a-z0-9_]{1,74}$/.test(candidateCode)
      ? candidateCode
      : args.fallbackCode
  const networkCode = networkTransportErrorCode(args.error)
  return {
    code,
    stage: args.stage,
    message: args.fallbackMessage,
    ...(networkCode ? { networkCode } : {})
  }
}
