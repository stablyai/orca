export type RuntimeAccessGrant = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number | null
}

/** Result of sharing this server "from any network": a runtime link that carries an Orca Relay invite. */
export type RuntimeRelayPairingUrlResult =
  | { available: true; pairingUrl: string; inviteExpiresAt: number; deviceId: string }
  | { available: false; reason: string; guidance: string }
