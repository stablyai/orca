import type { OrcaCloudTeamPolicy } from './orca-cloud-team-policy'

export type OrcaCloudCapabilityFlags = Record<string, boolean>

export type OrcaCloudCapabilities = {
  flags: OrcaCloudCapabilityFlags
  refreshedAt: number
  teamPolicy?: OrcaCloudTeamPolicy
  /** The web console's https origin, as auth advertises it (its ticket URLs land there). */
  consoleOrigin?: string
}

/**
 * The Relay one-link rollout, resolved per account by Orca Cloud (permille plus an account
 * allowlist on the server); absent means off.
 */
export const ORCA_CLOUD_RELAY_ONE_LINK_FLAG = 'relay.oneLink'
