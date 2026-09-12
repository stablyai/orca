import type { z } from 'zod'
import type {
  AiVaultSearchRequestSchema,
  AiVaultSearchResponseSchema,
  AiVaultSearchHitSchema,
  AiVaultSearchStatusSchema
} from './ai-vault-search-contract'

/**
 * Tool output beyond 3,072 characters per row is not indexed and not searchable; user and assistant text is indexed in full.
 * A page cursor outstanding during a retention purge is refused once as `stale-cursor`; the client re-issues page 1.
 * A phrase match across a chunk boundary of a long message is not supported.
 */
export type AiVaultSearchRequest = z.input<typeof AiVaultSearchRequestSchema>
/** Pages belong to one host; callers re-issue page 1 after a stale cursor. */
export type AiVaultSearchResponse = z.infer<typeof AiVaultSearchResponseSchema>
/** Evidence is null for operator-only matches; remote callers receive source presence only. */
export type AiVaultSearchHit = z.infer<typeof AiVaultSearchHitSchema>
export type AiVaultSearchStatus = z.infer<typeof AiVaultSearchStatusSchema>
