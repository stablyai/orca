import { z } from 'zod'

/**
 * LIVE-GIT-ACCESS: POST /v1/sandboxes/:id/git/access. `applied`: the GitHub App's repo token is live in the
 * running VM now (no restart). Otherwise why not: not installed yet, not running, or not a GitHub repo.
 */
export const HostedGitAccessResponseSchema = z.union([
  z.object({ applied: z.literal(true), expiresAt: z.number() }),
  z.object({ applied: z.literal(false), reason: z.string() })
])
export type HostedGitAccessResponse = z.infer<typeof HostedGitAccessResponseSchema>
