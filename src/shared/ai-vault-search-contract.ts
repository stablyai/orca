import { resolveSessionSearchLimit, SESSION_SEARCH_LIMIT_MAX } from './ai-vault-search-limit'
import { z } from 'zod'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from './ai-vault-types'

export const AiVaultSearchFiltersSchema = z.object({
  agents: z.array(z.enum(AI_VAULT_AGENTS)).optional(),
  scopePaths: z.array(z.string().min(1).max(4096)).max(AI_VAULT_SCOPE_PATHS_MAX_COUNT).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['relevance', 'newest']).optional()
})

// Strip unknown fields so legacy tier/refresh are accepted without affecting the query.
export const AiVaultSearchRequestSchema = z.object({
  query: z.string(),
  scope: z.enum(['conversation', 'all']).optional(),
  freshness: z.enum(['indexed', 'wait-until-current']).optional(),
  limit: z.number().optional().transform(resolveSessionSearchLimit),
  cursor: z.string().optional(),
  filters: AiVaultSearchFiltersSchema.optional(),
  debug: z.boolean().optional()
})

export const AiVaultSearchSourceSchema = z.object({
  presence: z.enum(['present', 'unverifiable', 'missing']),
  filePath: z.string().optional(),
  codexHome: z.string().optional()
})
export const AiVaultSearchEvidenceSchema = z.object({
  snippet: z.string(),
  role: z.enum(['user', 'assistant', 'tool', 'system', 'unknown']),
  timestamp: z.string().nullable()
})
export const AiVaultSearchHitSchema = z
  .object({
    agent: z.enum(AI_VAULT_AGENTS),
    sessionId: z.string(),
    title: z.string(),
    cwd: z.string().nullable(),
    branch: z.string().nullable(),
    updatedAt: z.string().nullable(),
    messageCount: z.number().int().nonnegative(),
    score: z.number(),
    source: AiVaultSearchSourceSchema,
    evidence: AiVaultSearchEvidenceSchema.nullable(),
    resumeCommand: z.string().optional()
  })
  .refine((hit) => hit.source.presence === 'present' || hit.resumeCommand === undefined, {
    message: 'Only present sources may have a resume command'
  })
export const AiVaultSearchPageSchema = z.object({
  cursor: z.string().nullable(),
  hasMore: z.boolean()
})
export const AiVaultSearchTruncationSchema = z.object({
  candidates: z.boolean(),
  snippets: z.number().int().nonnegative(),
  query: z.boolean(),
  freshness: z.boolean()
})
const routeSchema = z.enum(['phrase', 'and', 'or', 'typo+phrase', 'typo+and', 'typo+or'])
export const AiVaultSearchPlannerReportSchema = z.object({
  route: routeSchema,
  repairedTerms: z.array(z.string()).optional(),
  scope: z.enum(['conversation', 'all'])
})
export const AiVaultSearchDebugSchema = z.object({
  route: routeSchema,
  repairedTerms: z.array(z.string()).optional(),
  plannerReport: AiVaultSearchPlannerReportSchema
})
export const AiVaultSearchResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('results'),
    hits: z.array(AiVaultSearchHitSchema).max(SESSION_SEARCH_LIMIT_MAX),
    page: AiVaultSearchPageSchema,
    generation: z.number().int().nonnegative(),
    truncated: AiVaultSearchTruncationSchema,
    durationMs: z.number().nonnegative(),
    debug: AiVaultSearchDebugSchema.optional()
  }),
  z.object({
    kind: z.literal('stale-cursor'),
    generation: z.number().int().nonnegative(),
    expectedGeneration: z.number().int().nonnegative().optional()
  }),
  z.object({ kind: z.literal('malformed-cursor') }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['disabled', 'not-ready', 'no-service'])
  })
])
export const AiVaultSearchStatusRequestSchema = z.object({})
export const AiVaultSearchStatusSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(['idle', 'indexing', 'current', 'degraded', 'closed']),
  filesIndexed: z.number().int().nonnegative(),
  filesDue: z.number().int().nonnegative(),
  filesFailed: z.number().int().nonnegative(),
  degradedRoots: z.array(z.object({ root: z.string(), reason: z.string() })),
  lastReconcileAt: z.number().nullable(),
  lastSweepCompletedAt: z.number().nullable(),
  generation: z.number().int().nonnegative()
})
