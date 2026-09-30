import { z } from 'zod'
import { parseExecutionHostId } from '../execution-host'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../ai-vault-types'
import { OptionalBoolean } from './rpc-param-primitives'
import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../ai-vault-session-title'

// Why: bound limit + scopePaths so a client cannot force an unbounded scan.
// Each scopePath is a host-local match prefix (validated/capped, never used for
// traversal); the count/length caps mirror the worktree-schemas bounding style.
export const AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096

export const AI_VAULT_LIMIT_MAX = 2000

export const executionHostIdSchema = z.string().transform((value, ctx): `runtime:${string}` => {
  const parsed = parseExecutionHostId(value)
  if (parsed?.kind === 'runtime') {
    return parsed.id
  }
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid runtime execution host id'
  })
  return z.NEVER
})

export const AiVaultListSessionsParams = z
  .object({
    limit: z
      .unknown()
      .transform((value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      )
      .pipe(z.union([z.number().int(), z.undefined()]))
      .optional(),
    unlimited: OptionalBoolean,
    force: OptionalBoolean,
    scopePaths: z
      .array(z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH))
      // Why: clamp instead of reject — scope paths only ever widen discovery, and
      // rejecting would hard-break older/uncapped producers (web client, pre-cap
      // desktop parents) that send more than the bound.
      .transform((paths) => paths.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT))
      .optional(),
    // Why: desktop/web callers name the runtime host they are addressing; mobile
    // omits it. The scan itself is host-local either way, so the id must never
    // change what is scanned — it only restamps the shared cached result.
    executionHostId: executionHostIdSchema.optional()
  })
  .superRefine((params, ctx) => {
    if (params.unlimited !== true && params.limit && params.limit > AI_VAULT_LIMIT_MAX) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: 'Limit exceeds maximum' })
    }
  })

export const AiVaultPrepareSessionResumeParams = z.object({
  agent: z.enum(AI_VAULT_AGENTS),
  sessionId: z.string().min(1).max(512).optional(),
  filePath: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH),
  codexHome: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH).nullable(),
  executionHostId: z.string().optional()
})

export const AiVaultSessionTitlesParams = z.object({
  requests: z
    .array(
      z.object({
        agent: z.enum(['claude', 'codex']),
        sessionId: z.string().min(1).max(512),
        transcriptPath: z.string().min(1).max(32_768).optional()
      })
    )
    .max(AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)
})
