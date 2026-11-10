// Orca Cloud programmatic access (API keys, org settings, audit, routines): the control plane's
// /v1 wire shapes, validated in main before anything reaches the renderer. Shared by main + renderer.
import { z } from 'zod'

export * from './cloud-api-primitives'
export * from './cloud-api-routine-types'
import { CLOUD_API_SCOPES, Id, Millis, PersonName, Scopes } from './cloud-api-primitives'

export const CloudApiMeSchema = z.object({
  accountId: Id,
  userId: Id,
  orgId: Id.nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  scopes: Scopes
})
export type CloudApiMe = z.infer<typeof CloudApiMeSchema>

export const CloudApiKeySchema = z.object({
  id: Id,
  name: z.string().max(200),
  prefix: z.string().max(64),
  scopes: Scopes,
  createdBy: Id,
  createdByName: PersonName,
  createdAt: Millis,
  lastUsedAt: Millis.nullable(),
  expiresAt: Millis.nullable()
})
export type CloudApiKey = z.infer<typeof CloudApiKeySchema>

export const CloudApiKeyListSchema = z.object({
  keys: z.array(CloudApiKeySchema).max(500),
  availableScopes: Scopes
})
export type CloudApiKeyList = z.infer<typeof CloudApiKeyListSchema>

// The secret is the one thing that cannot be fetched again: never let drift in the key's
// metadata turn a freshly minted (already live) key into an "invalid response".
export const CloudApiCreatedKeySchema = z.object({
  key: CloudApiKeySchema.nullable().catch(null),
  secret: z.string().regex(/^orca_[a-z]+_[A-Za-z0-9]{16,128}$/)
})
export type CloudApiCreatedKey = z.infer<typeof CloudApiCreatedKeySchema>

/** One-time code (10 min, single use) the user pastes on the MCP consent page to approve an app. */
export const CloudApiApprovalSchema = z.object({
  code: z.string().regex(/^orca_ap_[A-Za-z0-9]{16,128}$/),
  expiresAt: Millis,
  scopes: Scopes
})
export type CloudApiApproval = z.infer<typeof CloudApiApprovalSchema>

export const CreateCloudApiApprovalInputSchema = z
  .object({
    scopes: z.array(z.enum(CLOUD_API_SCOPES)).min(1).max(CLOUD_API_SCOPES.length).optional()
  })
  .strict()
export type CreateCloudApiApprovalInput = z.infer<typeof CreateCloudApiApprovalInputSchema>

/** A connected MCP app (an OAuth grant family). */
export const CloudApiGrantSchema = z.object({
  id: Id,
  clientId: z.string().max(200).nullable(),
  clientName: z.string().max(200).nullable(),
  userId: Id,
  userName: PersonName,
  scopes: Scopes,
  /** Where the app sends people after approval: the real identity behind a self-declared name. */
  redirectHosts: z.array(z.string().max(253)).max(20).optional(),
  approvedWith: z.union([
    z.object({ apiKeyPrefix: z.string().max(64) }),
    z.object({ approvalCode: z.literal(true) })
  ]),
  grantedAt: Millis,
  lastUsedAt: Millis.nullable(),
  expiresAt: Millis.nullable()
})
export type CloudApiGrant = z.infer<typeof CloudApiGrantSchema>
export const CloudApiGrantListSchema = z.object({ grants: z.array(CloudApiGrantSchema).max(500) })

export const CloudApiSettingsSchema = z.object({
  settings: z.object({ vmCliEnabled: z.boolean() }),
  canEdit: z.boolean()
})
export type CloudApiSettings = z.infer<typeof CloudApiSettingsSchema>

export const CloudApiAuditEntrySchema = z.object({
  id: Id,
  actor: z.object({
    type: z.string().max(64),
    id: z.string().max(128),
    userId: z.string().max(128).nullable(),
    userName: PersonName
  }),
  action: z.string().max(128),
  target: z.object({ type: z.string().max(64), id: z.string().max(128).nullable() }).nullable(),
  // Free-form per action (e.g. a key's name); only short strings are ever shown.
  detail: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: Millis
})
export type CloudApiAuditEntry = z.infer<typeof CloudApiAuditEntrySchema>

export const CloudApiAuditPageSchema = z.object({
  entries: z.array(CloudApiAuditEntrySchema).max(500),
  nextBefore: Millis.nullable()
})
export type CloudApiAuditPage = z.infer<typeof CloudApiAuditPageSchema>

export const CloudApiProjectSchema = z.object({
  id: Id,
  name: z.string().max(200),
  repo: z.object({ url: z.string().max(2048), ref: z.string().max(255).nullable() }).nullable()
})
export type CloudApiProject = z.infer<typeof CloudApiProjectSchema>

export const CloudApiProjectListSchema = z.object({
  projects: z.array(CloudApiProjectSchema).max(1000)
})

export const CloudApiInstallationSchema = z.object({
  installationId: z.union([z.number(), z.string()]).transform(String),
  account: z.string().max(200),
  accountType: z.string().max(64).nullable().optional()
})
export type CloudApiInstallation = z.infer<typeof CloudApiInstallationSchema>

export const CloudApiInstallationListSchema = z.object({
  installations: z.array(CloudApiInstallationSchema).max(500)
})

// ── Renderer → main inputs (validated again in main) ────────────────────────

export const CreateCloudApiKeyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(CLOUD_API_SCOPES)).min(1).max(CLOUD_API_SCOPES.length),
    expiresInDays: z.number().int().min(1).max(365).optional()
  })
  .strict()
export type CreateCloudApiKeyInput = z.infer<typeof CreateCloudApiKeyInputSchema>

// ── Results ─────────────────────────────────────────────────────────────────

export const CLOUD_API_ERROR_CODES = [
  /** No control plane in this build. */
  'unconfigured',
  /** Not signed in to Orca, or the session expired. */
  'signed-out',
  /** Signed in, but this action needs an org owner/admin. */
  'admin-required',
  /** The key or token lacks a scope. */
  'forbidden',
  'not-found',
  /** The control plane does not offer this yet (older deployment). */
  'not-available',
  'invalid-request',
  'rate-limited',
  'network',
  'server',
  'invalid-response'
] as const
export type CloudApiErrorCode = (typeof CLOUD_API_ERROR_CODES)[number]

export type CloudApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CloudApiErrorCode; detail?: string; retryAfterSeconds?: number }

export type CloudApiAvailability =
  | { status: 'unconfigured' }
  | { status: 'ready'; controlPlaneUrl: string }
