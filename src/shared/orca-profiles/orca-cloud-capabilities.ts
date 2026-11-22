export type OrcaCloudCapabilityFlags = Record<string, boolean>

export type OrcaCloudCapabilities = {
  flags: OrcaCloudCapabilityFlags
  refreshedAt: number
  /** The web console's https origin, as auth advertises it (its ticket URLs land there). */
  consoleOrigin?: string
}
