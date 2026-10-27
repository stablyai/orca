import { z } from 'zod'

// Scope by identity for each host's catalog; request scope already names the search tier.
export const AiVaultSearchScopeIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), worktreeId: z.string().min(1).max(8192) }),
  z.object({
    kind: z.literal('project'),
    projectKey: z.string().min(1).max(1024),
    canonicalProjectKey: z.string().min(1).max(1024).optional()
  })
])

export type AiVaultSearchScopeIdentity = z.infer<typeof AiVaultSearchScopeIdentitySchema>
