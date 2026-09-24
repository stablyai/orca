import { z } from 'zod'

export const ORCAD_PROFILE_PREFLIGHT_FLAG = '--orcad-profile-state-preflight'

export const orcadProfilePreflightResponseSchema = z.object({
  type: z.literal('orca_profile_state_ready'),
  nonce: z.string().uuid(),
  runtime: z.enum(['node', 'bun']),
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
  runtimeVersion: string,
  artifactVersion?: string
): OrcadProfilePreflightResponse {
  const response = orcadProfilePreflightResponseSchema.parse(JSON.parse(output.trim()))
  if (
    response.nonce !== nonce ||
    response.runtime !== 'bun' ||
    response.runtimeVersion !== runtimeVersion ||
    (artifactVersion !== undefined && response.artifactVersion !== artifactVersion)
  ) {
    throw new Error('Profile preflight did not run under the expected candidate runtime')
  }
  return response
}
