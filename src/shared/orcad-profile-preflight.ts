import { z } from 'zod'

export const ORCAD_PROFILE_PREFLIGHT_FLAG = '--orcad-profile-state-preflight'
export const ORCAD_STARTUP_PREFLIGHT_FLAG = '--orcad-startup-preflight'
export const ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS = 90_000
// Server startup follows the disposable native/SQLite probe on every bundled launch.
export const ORCAD_STARTUP_READINESS_TIMEOUT_MS = ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS + 90_000

export const ORCAD_PREFLIGHT_RUNTIMES = ['node', 'bun'] as const

/** The runtime the caller launched; the candidate must prove it ran under exactly this one. */
export type OrcadPreflightRuntimeIdentity = {
  runtime: (typeof ORCAD_PREFLIGHT_RUNTIMES)[number]
  runtimeVersion: string
}

export const orcadProfilePreflightResponseSchema = z.object({
  type: z.literal('orca_profile_state_ready'),
  nonce: z.string().uuid(),
  runtime: z.enum(ORCAD_PREFLIGHT_RUNTIMES),
  runtimeVersion: z.string().min(1),
  artifactVersion: z.string().regex(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/),
  sqliteVersion: z.string().min(1),
  revision: z.number().int().positive()
})

export type OrcadProfilePreflightResponse = z.infer<typeof orcadProfilePreflightResponseSchema>

/** A fresh challenge prevents stale or unrelated output from admitting a candidate. */
export function parseOrcadProfilePreflight(
  output: string,
  nonce: string,
  expected: OrcadPreflightRuntimeIdentity,
  artifactVersion?: string
): OrcadProfilePreflightResponse {
  const response = orcadProfilePreflightResponseSchema.parse(JSON.parse(output.trim()))
  if (
    response.nonce !== nonce ||
    response.runtime !== expected.runtime ||
    response.runtimeVersion !== expected.runtimeVersion ||
    (artifactVersion !== undefined && response.artifactVersion !== artifactVersion)
  ) {
    throw new Error('Profile preflight did not run under the expected candidate runtime')
  }
  return response
}
