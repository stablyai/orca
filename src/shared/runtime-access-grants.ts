export type RuntimeAccessGrant = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  /** The link's last sign-in used the older E2EE framing; absent from older hosts. */
  usesLegacyEncryption?: boolean
}
