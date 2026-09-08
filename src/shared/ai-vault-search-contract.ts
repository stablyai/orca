import { z } from 'zod'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from './ai-vault-types'
import {
  AI_VAULT_SEARCH_LIMIT_MAX,
  AI_VAULT_SEARCH_QUERY_MAX_LENGTH
} from './ai-vault-search-types'

export const SESSION_SEARCH_OPERATIONS = ['query', 'status', 'configure'] as const
export type SessionSearchOperation = (typeof SESSION_SEARCH_OPERATIONS)[number]

/**
 * One record per operation across the three method namespaces it travels.
 * They are not the same names — `configure` is `aiVault.searchConfigure` on the
 * relay and `aiVault.configureSessionSearch` on a runtime — so registering and
 * calling from here is what keeps a registered name and a called name in step.
 */
export const SESSION_SEARCH_METHODS = {
  query: {
    relay: 'aiVault.searchSessions',
    runtime: 'aiVault.searchSessions',
    runtimeSsh: 'aiVault.sshSearchSessions'
  },
  status: {
    relay: 'aiVault.searchIndexStatus',
    runtime: 'aiVault.searchIndexStatus',
    runtimeSsh: 'aiVault.sshSearchIndexStatus'
  },
  configure: {
    relay: 'aiVault.searchConfigure',
    runtime: 'aiVault.configureSessionSearch',
    runtimeSsh: 'aiVault.sshSearchConfigure'
  },
  // Progress polling reads the addressed runtime's own indexer, so it is the one
  // search-family method with no relay or SSH route to keep in step.
  coverage: { runtime: 'aiVault.searchCoverage' }
} as const satisfies Record<
  SessionSearchOperation,
  { relay: string; runtime: string; runtimeSsh: string }
> & { coverage: { runtime: string } }

export const SessionSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(AI_VAULT_SEARCH_QUERY_MAX_LENGTH),
  limit: z.number().int().min(1).max(AI_VAULT_SEARCH_LIMIT_MAX).optional(),
  agents: z.array(z.enum(AI_VAULT_AGENTS)).max(AI_VAULT_AGENTS.length).optional(),
  scopePaths: z.array(z.string().min(1).max(4096)).max(AI_VAULT_SCOPE_PATHS_MAX_COUNT).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['relevance', 'newest']).optional(),
  tier: z.enum(['full', 'conversation']).optional(),
  refresh: z.boolean().optional()
})

export const SessionSearchConfigureSchema = z.object({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  historyDays: z.number().int().min(1).max(3650).nullable().optional(),
  clearIndex: z.boolean().optional()
})
export type SessionSearchConfigure = z.infer<typeof SessionSearchConfigureSchema>

export const SessionSearchStatusSchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean().optional(),
  historyDays: z.number().int().positive().nullable(),
  indexSizeBytes: z.number().nonnegative().nullable(),
  available: z.boolean().optional(),
  applied: z.boolean().optional(),
  reason: z.string().max(4096).optional()
})

const boundedText = z.string().max(32768)

const ROUTES = ['phrase', 'and', 'or', 'typo+phrase', 'typo+and', 'typo+or'] as const
const ROLES = ['user', 'assistant', 'tool', 'system', 'unknown'] as const
const BACKFILL_STATES = ['idle', 'running', 'complete'] as const
const INDEXING_PHASES = [
  'idle',
  'discovering',
  'indexing',
  'updating',
  'paused',
  'complete',
  'error'
] as const

/**
 * The shape a result must have to be sent. Strict on purpose: this process wrote
 * it, so an enum value outside the list is a producer bug and has to fail here
 * rather than be rewritten into something plausible.
 */
export const OutboundSessionSearchHitSchema = z.object({
  agent: z.enum(AI_VAULT_AGENTS),
  sessionId: boundedText,
  filePath: boundedText,
  codexHome: boundedText.nullable(),
  title: boundedText,
  cwd: boundedText.nullable(),
  branch: boundedText.nullable(),
  updatedAt: boundedText.nullable(),
  messageCount: z.number().nonnegative(),
  resumeCommand: boundedText,
  score: z.number(),
  duplicateCount: z.number().optional(),
  evidence: z.object({
    role: z.enum(ROLES),
    timestamp: boundedText.nullable(),
    snippet: boundedText
  })
})

const OutboundIndexingSchema = z.object({
  phase: z.enum(INDEXING_PHASES),
  filesProcessed: z.number().nonnegative(),
  filesTotal: z.number().nonnegative().nullable(),
  failures: z.number().nonnegative(),
  startedAt: z.number()
})

export const OutboundSessionSearchResultSchema = z.object({
  hits: z.array(OutboundSessionSearchHitSchema).max(AI_VAULT_SEARCH_LIMIT_MAX),
  route: z.enum(ROUTES),
  repairedTerms: z.array(boundedText).max(512).optional(),
  durationMs: z.number().nonnegative(),
  coverage: z.object({
    enabled: z.boolean().optional(),
    sessionsIndexed: z.number().nonnegative(),
    messagesIndexed: z.number().nonnegative(),
    providers: z
      .array(
        z.object({
          agent: z.enum(AI_VAULT_AGENTS),
          sessionsIndexed: z.number().nonnegative(),
          messagesIndexed: z.number().nonnegative(),
          filesDiscovered: z.number().optional(),
          parseFailures: z.number().optional(),
          scanIssues: z.number().optional()
        })
      )
      .max(AI_VAULT_AGENTS.length),
    backfill: z.enum(BACKFILL_STATES),
    filesPending: z.number().nonnegative(),
    lastIndexedAt: boundedText.nullable(),
    indexing: OutboundIndexingSchema.optional()
  }),
  omittedHits: z.number().int().nonnegative().optional(),
  truncatedSnippets: z.number().int().nonnegative().optional(),
  sourceUnavailableFiles: z.number().int().nonnegative().optional()
})

/**
 * The same shape as it arrives from another host. Why the enums fall back here
 * and nowhere else: a client and the host it queries update independently, so a
 * host that learns one new route, indexing phase, or message role must not cost
 * an older client the whole response. Each fallback is the value that already
 * means "nothing specific", and an unknown one is never read as finished work.
 */
export const ReceivedSessionSearchResultSchema = OutboundSessionSearchResultSchema.extend({
  // Why per-hit and not per-response: an agent the client cannot name has no
  // resume command it could run, so that hit is the only thing it should lose.
  hits: z
    .array(
      OutboundSessionSearchHitSchema.extend({
        evidence: OutboundSessionSearchHitSchema.shape.evidence.extend({
          role: z.enum(ROLES).catch('unknown')
        })
      })
        .nullable()
        .catch(null)
    )
    .max(AI_VAULT_SEARCH_LIMIT_MAX)
    .transform((hits) => hits.filter((hit) => hit !== null)),
  route: z.enum(ROUTES).catch('or'),
  coverage: OutboundSessionSearchResultSchema.shape.coverage.extend({
    // An unknown backfill state is not evidence the index is finished.
    backfill: z.enum(BACKFILL_STATES).catch('running'),
    // Unknown phases report as work in flight; `idle` would claim the opposite
    // of what a newer host is telling us.
    indexing: OutboundIndexingSchema.extend({
      phase: z.enum(INDEXING_PHASES).catch('indexing')
    }).optional()
  })
})
