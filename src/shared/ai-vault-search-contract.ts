import { resolveSessionSearchLimit, SESSION_SEARCH_LIMIT_MAX } from './ai-vault-search-limit'
import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  AI_VAULT_SEARCH_SORTS
} from './ai-vault-types'
import { AiVaultSearchScopeIdentitySchema } from './ai-vault-search-scope'

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
// Older hosts may omit attribution; the desktop stamps remote answers.
const executionHostIdSchema = z.string().min(1)

export const AiVaultSearchHitSchema = z
  .object({
    agent: z.enum(AI_VAULT_AGENTS),
    executionHostId: executionHostIdSchema.optional(),
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
/**
 * Per-host outcomes of an all-computers merge. Additive and desktop-only: no
 * host publishes this, and a reader that does not know it simply drops it.
 */
export const AiVaultSearchHostOutcomeSchema = z.object({
  executionHostId: executionHostIdSchema,
  outcome: z.enum([
    'searched',
    'stale',
    'disabled',
    'not-ready',
    'no-service',
    'unreachable',
    // This host does not know the workspace or project the scope named.
    'scope-unknown'
  ])
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
    debug: AiVaultSearchDebugSchema.optional(),
    hosts: z.array(AiVaultSearchHostOutcomeSchema).optional()
  }),
  z.object({
    kind: z.literal('stale-cursor'),
    generation: z.number().int().nonnegative(),
    expectedGeneration: z.number().int().nonnegative().optional()
  }),
  z.object({ kind: z.literal('malformed-cursor') }),
  z.object({
    kind: z.literal('unavailable'),
    // `scope-unknown` only ever answers a request that carried `within`, so a
    // client too old to send one can never receive a reason it cannot parse.
    reason: z.enum(['disabled', 'not-ready', 'no-service', 'scope-unknown'])
  })
])
export const AiVaultSearchStatusRequestSchema = z.object({})
/** Consent flip for one host's index. Answered with that host's status after the change is applied. */
export const AiVaultSetSearchEnabledParamsSchema = z.object({ enabled: z.boolean() })
export const AiVaultSearchStatusSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(['idle', 'indexing', 'current', 'degraded', 'closed']),
  filesIndexed: z.number().int().nonnegative(),
  filesDue: z.number().int().nonnegative(),
  filesFailed: z.number().int().nonnegative(),
  // Optional: a host that predates this field degrades to a session count only.
  messagesIndexed: z.number().int().nonnegative().optional(),
  // `root` is a host path, withheld over the relay; the array length is the count.
  degradedRoots: z.array(z.object({ root: z.string().optional(), reason: z.string() })),
  lastReconcileAt: z.number().nullable(),
  lastSweepCompletedAt: z.number().nullable(),
  // Optional: an older host answers without it, and a reader that has none
  // should show no breakdown rather than a breakdown of zeroes.
  sessionsByAgent: z.record(z.string(), z.number().int().nonnegative()).optional(),
  generation: z.number().int().nonnegative()
})
