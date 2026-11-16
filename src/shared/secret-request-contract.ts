import { z } from 'zod'

/** Agent-initiated secret requests (agent-sources contract §3). The value never travels through orcad
 *  or the agent: the desktop saves it to the control plane, which refreshes the session env. */
export const SECRETS_REQUEST_METHOD = 'secrets.request'
export const SECRETS_REQUEST_STATUS_METHOD = 'secrets.requestStatus'
export const SECRETS_TOUCH_REQUEST_METHOD = 'secrets.touchRequest'
export const SECRETS_RESOLVE_REQUEST_METHOD = 'secrets.resolveRequest'

/** Client event types (runtime.clientEvents.subscribe). */
export const SECRETS_REQUESTED_EVENT = 'secrets.requested'
export const SECRETS_REQUEST_UPDATED_EVENT = 'secrets.requestUpdated'
export const SECRETS_REQUEST_SETTLED_EVENT = 'secrets.requestSettled'

export const SECRET_REQUEST_REASON_MAX = 200
export const SECRET_REQUEST_TTL_MS = 15 * 60_000
/** touchRequest extends to now + TTL, never past this long after the request. */
export const SECRET_REQUEST_MAX_LIFETIME_MS = 60 * 60_000
export const SECRET_REQUEST_MAX_PENDING = 3
export const SECRET_REQUEST_MAX_PER_HOUR = 10

export const SecretRequestScopeSchema = z.enum(['personal', 'repo'])
export type SecretRequestScope = z.infer<typeof SecretRequestScopeSchema>

const RequestId = z.string().regex(/^sr_[A-Za-z0-9_-]{8,64}$/)

// C0/C1 controls (newlines, escapes) become spaces; bidi overrides and isolates are dropped, so the
// agent's text can't reorder or restyle what the person reads.
// oxlint-disable-next-line no-control-regex -- SAFETY: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g
const BIDI_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export function sanitizeSecretRequestReason(reason: string): string {
  return reason.replace(BIDI_CHARS, '').replace(CONTROL_CHARS, ' ').replace(/ {2,}/g, ' ').trim()
}

export const SecretsRequestParamsSchema = z
  .object({
    // Shape only; the name rules (reserved names, agent credentials) are checked by the handler so the
    // agent gets a specific error code back.
    name: z.string().min(1).max(128),
    reason: z
      .string()
      .max(SECRET_REQUEST_REASON_MAX * 4)
      .transform(sanitizeSecretRequestReason)
      .pipe(z.string().min(1).max(SECRET_REQUEST_REASON_MAX)),
    /** A hint only: the card always preselects Personal. */
    scope: SecretRequestScopeSchema.optional(),
    /** A hint, kept only when this orcad knows the worktree. The agent and its terminal come from the
     *  caller identity orcad verifies (launch evidence), never from params. */
    worktreeId: z.string().min(1).max(512).optional()
  })
  .strict()
export type SecretsRequestParams = z.infer<typeof SecretsRequestParamsSchema>

export const SecretsRequestIdParamsSchema = z.object({ requestId: RequestId }).strict()

export const SecretsResolveRequestParamsSchema = z
  .object({ requestId: RequestId, outcome: z.enum(['provided', 'declined']) })
  .strict()

export type SecretRequestStatus = 'pending' | 'provided' | 'declined' | 'expired'

export type SecretsRequestResult =
  | { requestId: string; status: 'pending' }
  /** The name is already in the session env; nothing was queued. */
  | { requestId: null; status: 'already-set' }

export type SecretsRequestStatusResult = {
  requestId: string
  name: string
  status: SecretRequestStatus
  expiresAt: number
}

export type SecretsTouchRequestResult = { expiresAt: number }

export type SecretsResolveRequestResult = { outcome: 'provided' | 'declined' | 'expired' }

/** Sent to connected clients when a request is made, and replayed on attach until it expires. */
export type SecretRequestedEvent = {
  type: typeof SECRETS_REQUESTED_EVENT
  requestId: string
  name: string
  /** Untrusted agent text: show quoted and muted, never linkified. Omitted for phones (status only). */
  reason?: string
  scope: SecretRequestScope
  /** From the calling terminal's agent session, never from the caller; null when unknown. */
  agent: string | null
  worktreeId: string | null
  terminalHandle?: string
  requestedAt: number
  expiresAt: number
}

/** touchRequest moved the expiry, so every client keeps the card as long. */
export type SecretRequestUpdatedEvent = {
  type: typeof SECRETS_REQUEST_UPDATED_EVENT
  requestId: string
  expiresAt: number
}

/** A request was provided, declined or expired, so other clients can drop their card. */
export type SecretRequestSettledEvent = {
  type: typeof SECRETS_REQUEST_SETTLED_EVENT
  requestId: string
  status: Exclude<SecretRequestStatus, 'pending'>
}

/** Error codes (RPC error message) the CLI and desktop map to guidance. */
export const SECRET_REQUEST_ERRORS = {
  invalidName: 'invalid_name',
  reservedName: 'reserved_name',
  subscriptionTokenRefused: 'subscription_token_refused',
  agentCredential: 'use_sign_in_or_cloud_secrets',
  tooManyPending: 'too_many_pending_requests',
  rateLimited: 'secret_request_rate_limited',
  notFound: 'secret_request_not_found',
  notPending: 'secret_request_not_pending',
  forbidden: 'secret_request_forbidden',
  /** Only a cloud workspace's orcad takes secret requests. */
  unavailable: 'secret_requests_unavailable'
} as const

/** Printed by the CLI once a request is provided. */
export function secretReloadHint(name: string): string {
  return `${name} is set for new shells in this workspace. To use it in this shell: eval "$(orca-env)" (fish: orca-env --fish | source).`
}
