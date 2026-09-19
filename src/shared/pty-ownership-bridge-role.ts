import { PtyOwnershipBridgeError } from './pty-ownership-bridge-errors'

export type PtyOwnershipBridgeRole = 'source' | 'destination'

export function assertPtyOwnershipBridgeRole(role: PtyOwnershipBridgeRole): void {
  if (role !== 'source' && role !== 'destination') {
    throw new PtyOwnershipBridgeError('identity-mismatch', 'unknown bridge role')
  }
}
