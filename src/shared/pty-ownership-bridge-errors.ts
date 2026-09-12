export class PtyOwnershipBridgeError extends Error {
  constructor(
    readonly reason:
      | 'invalid-capabilities'
      | 'unsupported'
      | 'identity-mismatch'
      | 'invalid-phase'
      | 'replay-unavailable'
      | 'output-gap'
      | 'output-conflict'
      | 'input-conflict'
      | 'input-deduplication-unavailable'
      | 'input-deduplication-window-exhausted'
      | 'destination-not-caught-up',
    message: string
  ) {
    super(message)
    this.name = 'PtyOwnershipBridgeError'
  }
}
