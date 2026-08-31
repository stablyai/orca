import type {
  PtyConsumerSessionGrant,
  PtyConsumerSessionHello,
  PtyConsumerSessionOptions
} from './pty-consumer-session-contract'
import { assertNonEmptyString, MAX_CAPABILITY_VERSIONS } from './pty-consumer-session-hello'

export function assertPtyConsumerSessionOptions(options: PtyConsumerSessionOptions): void {
  assertNonEmptyString(options.serverBuildId, 'serverBuildId')
  if (
    options.outputFlowControl &&
    (!Number.isSafeInteger(options.outputFlowControl.maxWindowSu) ||
      options.outputFlowControl.maxWindowSu <= 0 ||
      options.outputFlowControl.versions.length > MAX_CAPABILITY_VERSIONS ||
      options.outputFlowControl.versions.some(
        (version) => !Number.isSafeInteger(version) || version <= 0
      ))
  ) {
    throw new Error('outputFlowControl support is invalid')
  }
  if (
    options.identityEvidence &&
    (options.identityEvidence.versions.length > MAX_CAPABILITY_VERSIONS ||
      options.identityEvidence.versions.some(
        (version) => !Number.isSafeInteger(version) || version <= 0
      ))
  ) {
    throw new Error('identityEvidence support is invalid')
  }
  if (
    options.ownerGraceMs !== undefined &&
    (!Number.isSafeInteger(options.ownerGraceMs) || options.ownerGraceMs < 0)
  ) {
    throw new Error('ownerGraceMs must be a non-negative safe integer')
  }
}

export function intersectPtyConsumerCapabilities(
  hello: PtyConsumerSessionHello,
  support: PtyConsumerSessionOptions['outputFlowControl'],
  identitySupport: PtyConsumerSessionOptions['identityEvidence'] = undefined
): Pick<PtyConsumerSessionGrant, 'capabilities'> {
  const offer = hello.capabilities?.outputFlowControl
  const identityOffer = hello.capabilities?.identityEvidence
  const outputSupported = Boolean(
    offer && support && offer.versions.includes(1) && support.versions.includes(1)
  )
  const identitySupported = Boolean(identityOffer && identitySupport?.versions.includes(1))
  if (!outputSupported && !identitySupported) {
    return {}
  }
  return {
    capabilities: {
      ...(outputSupported
        ? {
            outputFlowControl: {
              version: 1,
              windowSu: Math.min(offer!.requestedWindowSu, support!.maxWindowSu)
            }
          }
        : {}),
      ...(identitySupported ? { identityEvidence: { version: 1 as const } } : {})
    }
  }
}
