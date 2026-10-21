import { z } from 'zod'

// Named by identity, not by path, so each host resolves it against its own
// catalog; `scope` on the request already means the search tier.
export const AiVaultSearchScopeIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), worktreeId: z.string().min(1).max(8192) }),
  z.object({ kind: z.literal('project'), projectKey: z.string().min(1).max(1024) })
])

export type AiVaultSearchScopeIdentity = z.infer<typeof AiVaultSearchScopeIdentitySchema>
