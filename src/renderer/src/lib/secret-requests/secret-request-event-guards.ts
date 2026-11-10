// The host's events are checked before a card shows them: a malformed or oversized one is dropped.
import { z } from 'zod'
import {
  SECRET_REQUEST_REASON_MAX,
  SECRETS_REQUEST_SETTLED_EVENT,
  SECRETS_REQUEST_UPDATED_EVENT,
  SECRETS_REQUESTED_EVENT,
  type SecretRequestedEvent,
  type SecretRequestSettledEvent,
  type SecretRequestUpdatedEvent
} from '../../../../shared/secret-request-contract'

const RequestId = z.string().regex(/^sr_[A-Za-z0-9_-]{8,64}$/)
const Millis = z.number().finite().nonnegative()

const RequestedSchema = z.object({
  type: z.literal(SECRETS_REQUESTED_EVENT),
  requestId: RequestId,
  name: z
    .string()
    .max(128)
    .regex(/^[A-Z_][A-Z0-9_]*$/),
  reason: z.string().max(SECRET_REQUEST_REASON_MAX).optional(),
  scope: z.enum(['personal', 'repo']),
  agent: z.string().max(64).nullable(),
  worktreeId: z.string().max(512).nullable(),
  terminalHandle: z.string().min(1).max(512).optional(),
  requestedAt: Millis,
  expiresAt: Millis
})

const SettledSchema = z.object({
  type: z.literal(SECRETS_REQUEST_SETTLED_EVENT),
  requestId: RequestId,
  status: z.enum(['provided', 'declined', 'expired'])
})

const UpdatedSchema = z.object({
  type: z.literal(SECRETS_REQUEST_UPDATED_EVENT),
  requestId: RequestId,
  expiresAt: Millis
})

export function isSecretRequestUpdatedEvent(value: unknown): value is SecretRequestUpdatedEvent {
  return UpdatedSchema.safeParse(value).success
}

export function isSecretRequestedEvent(value: unknown): value is SecretRequestedEvent {
  return RequestedSchema.safeParse(value).success
}

export function isSecretRequestSettledEvent(value: unknown): value is SecretRequestSettledEvent {
  return SettledSchema.safeParse(value).success
}
