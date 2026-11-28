import type { OrcaCloudTeamPolicy } from './orca-cloud-team-policy'

export type OrcaCloudCapabilityFlags = Record<string, boolean>

export type OrcaCloudCapabilities = {
  flags: OrcaCloudCapabilityFlags
  refreshedAt: number
  teamPolicy?: OrcaCloudTeamPolicy
  /** The web console's https origin, as auth advertises it (its ticket URLs land there). */
  consoleOrigin?: string
}
