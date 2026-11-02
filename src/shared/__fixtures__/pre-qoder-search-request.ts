// Pre-Qoder b49abdb request parser and closed agent enum; keep independent of the current catalog.
import { resolveSessionSearchLimit } from '../ai-vault-search-limit'
import { z } from 'zod'
export const AI_VAULT_AGENTS = [
  'claude',
  'codebuddy',
  'codex',
  'hermes',
  'pi',
  'omp',
  'prime-agent',
  'cursor',
  'gemini',
  'antigravity',
  'rovo',
  'copilot',
  'opencode',
  'opencode2',
  'zcode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi',
  'muse'
] as const
const AI_VAULT_SCOPE_PATHS_MAX_COUNT = 64
const AI_VAULT_SEARCH_SORTS = ['relevance', 'newest'] as const
import { AiVaultSearchScopeIdentitySchema } from '../ai-vault-search-scope'

export const AiVaultSearchFiltersSchema = z.object({
  agents: z.array(z.enum(AI_VAULT_AGENTS)).optional(),
  scopePaths: z.array(z.string().min(1).max(4096)).max(AI_VAULT_SCOPE_PATHS_MAX_COUNT).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(AI_VAULT_SEARCH_SORTS).optional()
})

// Strip unknown fields so legacy tier/refresh are accepted without affecting the query.
export const AiVaultSearchRequestSchema = z
  .object({
    query: z.string(),
    scope: z.enum(['conversation', 'all']).optional(),
    freshness: z.enum(['indexed', 'wait-until-current']).optional(),
    limit: z.number().optional().transform(resolveSessionSearchLimit),
    cursor: z.string().optional(),
    filters: AiVaultSearchFiltersSchema.optional(),
    /** Scope by identity, resolved into paths by whichever host answers. */
    within: AiVaultSearchScopeIdentitySchema.optional(),
    debug: z.boolean().optional()
  })
  // Two scopes in one request have no defined intersection, and guessing one
  // would be the silent widening this field exists to remove. Neither is still
  // legal and still means every session.
  .refine(
    (request) => request.within === undefined || (request.filters?.scopePaths ?? []).length === 0,
    { message: 'A search carries either a scope identity or explicit scope paths, not both' }
  )
