import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Scope by identity for each host's catalog; request scope already names the search tier.
export const AiVaultSearchScopeIdentitySchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace'), worktreeId: z.string().min(1).max(8192) }),
    z.object({ kind: z.literal('project'), projectKey: z.string().min(1).max(1024) })
  ])
)

export type AiVaultSearchScopeIdentity = z.infer<typeof AiVaultSearchScopeIdentitySchema>
