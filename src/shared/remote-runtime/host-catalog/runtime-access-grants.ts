export type RuntimeAccessGrant = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  /** The link's last sign-in used the older E2EE framing; absent from older hosts. */
  usesLegacyEncryption?: boolean
  // Signed in with the link but never swapped it for its own credential (an older Orca).
  olderPairingMethod?: true
}
