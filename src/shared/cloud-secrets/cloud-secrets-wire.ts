// Wire shapes of the Orca Cloud secrets API (control plane /v1/secrets). Values only ever travel
// desktop -> control plane; no response carries one.
import { z } from 'zod'

export const CLOUD_SECRET_SCOPES = ['personal', 'org', 'repo'] as const
export type CloudSecretScope = (typeof CLOUD_SECRET_SCOPES)[number]
export type CloudSecretKind = 'env' | 'agent_key'

const Name = z.string().min(1).max(128)
const Scope = z.enum(CLOUD_SECRET_SCOPES)
const Kind = z.enum(['env', 'agent_key'])
const Hint = z.string().max(8).nullable()

export const CloudSecretViewSchema = z.object({
  scope: Scope,
  name: Name,
  kind: Kind,
  hint: Hint,
  updatedAt: z.number().finite(),
  updatedBy: z.string().max(256),
  repo: z.string().max(256).optional()
})
export type CloudSecretView = z.infer<typeof CloudSecretViewSchema>

export const CloudSecretListResponseSchema = z.object({
  secrets: z.array(CloudSecretViewSchema).max(1000)
})
export const CloudSecretPutResponseSchema = z.object({ secret: CloudSecretViewSchema })
export const CloudSecretDeleteResponseSchema = z.object({ deleted: z.literal(true) })

const BatchError = z.object({
  name: z.string().max(256),
  error: z.string().max(64),
  reason: z.string().max(64).optional()
})
export const CloudSecretBatchResponseSchema = z.object({
  secrets: z.array(CloudSecretViewSchema).max(200),
  deleted: z.array(Name).max(200),
  errors: z.array(BatchError).max(200)
})
export type CloudSecretBatchResult = z.infer<typeof CloudSecretBatchResponseSchema>

const OrgRole = z.enum(['owner', 'admin', 'member']).nullable()

export const CloudSecretsEffectiveResponseSchema = z.object({
  caller: z.object({
    userId: z.string().max(256),
    orgId: z.string().max(256).nullable(),
    orgRole: OrgRole,
    canWrite: z.object({ personal: z.boolean(), org: z.boolean(), repo: z.boolean() })
  }),
  precedence: z.object({ env: z.array(Scope).max(3), agent_key: z.array(Scope).max(3) }),
  secrets: z
    .array(
      z.object({
        name: Name,
        kind: Kind,
        scope: Scope,
        hint: Hint,
        updatedAt: z.number().finite(),
        shadowed: z.array(z.object({ scope: Scope, hint: Hint })).max(3)
      })
    )
    .max(1000)
})
export type CloudSecretsEffective = z.infer<typeof CloudSecretsEffectiveResponseSchema>
export type CloudSecretsCaller = CloudSecretsEffective['caller']
export type CloudEffectiveSecret = CloudSecretsEffective['secrets'][number]

export const CloudEnvRefreshResponseSchema = z.object({ applied: z.boolean() })

export const MAX_CLOUD_SECRET_BATCH = 100

/** Server reasons plus transport failures; the renderer turns these into copy. */
export type CloudSecretsErrorCode =
  | 'invalid_name'
  | 'reserved_name'
  | 'subscription_token_refused'
  | 'value_too_large'
  | 'invalid_value'
  | 'repo_required'
  | 'invalid_scope'
  | 'invalid_base_url'
  | 'org_admin_required'
  | 'no_org'
  | 'secret_limit'
  | 'unauthorized'
  | 'not_found'
  | 'unavailable'
  | 'timeout'
  | 'not_configured'
  | 'unknown'

const SERVER_REASONS = [
  'invalid_name',
  'reserved_name',
  'subscription_token_refused',
  'value_too_large',
  'invalid_value',
  'repo_required',
  'invalid_scope',
  'invalid_base_url',
  'org_admin_required',
  'no_org',
  'secret_limit'
] as const satisfies readonly CloudSecretsErrorCode[]

function isServerReason(reason: string): reason is (typeof SERVER_REASONS)[number] {
  return SERVER_REASONS.some((known) => known === reason)
}

export function cloudSecretsErrorCode(
  reason: string | null | undefined,
  fallback: CloudSecretsErrorCode = 'unknown'
): CloudSecretsErrorCode {
  return reason && isServerReason(reason) ? reason : fallback
}

export type CloudSecretsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudSecretsErrorCode }

/** Where a write lands; `repo` is `owner/name` or `github.com/owner/name`. */
export type CloudSecretTarget = { scope: CloudSecretScope; repo?: string }

export type CloudSecretsStatus = { available: boolean }
