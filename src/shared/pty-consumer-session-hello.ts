import type { PtyConsumerSessionHello } from './pty-consumer-session-contract'

export const MAX_CAPABILITY_VERSIONS = 8

export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${name} must be a non-empty string of at most 512 characters`)
  }
}

export function validateHello(hello: PtyConsumerSessionHello): void {
  assertNonEmptyString(hello.clientInstanceId, 'clientInstanceId')
  if (hello.requestedRole !== 'session-owner' && hello.requestedRole !== 'subscriber') {
    throw new Error('requestedRole must be session-owner or subscriber')
  }
  if (hello.resume) {
    if (!Number.isSafeInteger(hello.resume.ownerGeneration) || hello.resume.ownerGeneration <= 0) {
      throw new Error('resume.ownerGeneration must be a positive safe integer')
    }
    assertNonEmptyString(hello.resume.ownerLease, 'resume.ownerLease')
  }
  const flow = hello.capabilities?.outputFlowControl
  if (!flow) {
    return
  }
  if (
    !Array.isArray(flow.versions) ||
    flow.versions.length > MAX_CAPABILITY_VERSIONS ||
    flow.versions.some((version) => !Number.isSafeInteger(version) || version <= 0)
  ) {
    throw new Error('outputFlowControl.versions must contain positive safe integers')
  }
  if (!Number.isSafeInteger(flow.requestedWindowSu) || flow.requestedWindowSu <= 0) {
    throw new Error('outputFlowControl.requestedWindowSu must be a positive safe integer')
  }
}

// Why: a duplicate open on one connection is only idempotent if it asks for exactly the same thing.
export function helloFingerprint(hello: PtyConsumerSessionHello): string {
  const flow = hello.capabilities?.outputFlowControl
  return JSON.stringify({
    clientInstanceId: hello.clientInstanceId,
    requestedRole: hello.requestedRole,
    resume: hello.resume,
    outputFlowControl: flow
      ? {
          versions: [...flow.versions].sort((a, b) => a - b),
          requestedWindowSu: flow.requestedWindowSu
        }
      : undefined
  })
}
