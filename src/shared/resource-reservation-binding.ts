import { z } from 'zod'

export const RESOURCE_RESERVATION_KINDS = ['worktree', 'terminal'] as const
export type ResourceReservationKind = (typeof RESOURCE_RESERVATION_KINDS)[number]

/** Caller-generated single-use create key plus the external ledger binding it commits to.
 *  Every field is chosen by the caller before the resource exists, so a create whose reply was
 *  lost can still be attributed without heuristics. */
export type ResourceReservationRequest = {
  /** Single-use idempotency key. Also the durable replay lookup key. */
  key: string
  /** Ledger reservation nonce this create is bound to. */
  reservationId: string
  /** Caller session/instance that owns the reservation. */
  sessionId: string
  /** Resource the caller intends to create; must match the create surface it is sent to. */
  resourceKind: ResourceReservationKind
  /** Caller ownership generation. A later generation must never adopt an earlier binding. */
  ownershipGeneration: number
  /** Namespace of the issuing ledger, e.g. `openloop`. */
  issuer?: string
}

/** A request the host committed atomically with one provider resource. Immutable after create.
 *  No resource id is carried inside: the binding is stored on the resource record itself, so the
 *  stable id sits beside it in every show/list projection and cannot drift from it. */
export type ResourceReservationBinding = ResourceReservationRequest & {
  /** Host-stamped bind time; a client clock never sets it. */
  boundAt: number
}

export const RESOURCE_RESERVATION_CONFLICT_ERROR = 'reservation_conflict' as const

export const ResourceReservationRequestSchema = z.object({
  key: z.string().min(1).max(128),
  reservationId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  resourceKind: z.enum(RESOURCE_RESERVATION_KINDS),
  // Why int: a generation is a counter, and a fractional value would make the
  // "never adopt an earlier generation" comparison ambiguous across encoders.
  ownershipGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  issuer: z.string().min(1).max(128).optional()
})

/** Complete host-stamped binding schema used at durable trust boundaries. */
export const ResourceReservationBindingSchema = ResourceReservationRequestSchema.extend({
  boundAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})

/** Binding accepted by terminal-only authority stores. Keep the generic schema broad because
 * worktree reservation persistence legitimately uses the other discriminator. */
export const TerminalReservationBindingSchema = ResourceReservationBindingSchema.extend({
  resourceKind: z.literal('terminal')
})

export function buildResourceReservationBinding(
  request: ResourceReservationRequest,
  options: { boundAt: number }
): ResourceReservationBinding {
  return {
    key: request.key,
    reservationId: request.reservationId,
    sessionId: request.sessionId,
    resourceKind: request.resourceKind,
    ownershipGeneration: request.ownershipGeneration,
    ...(request.issuer ? { issuer: request.issuer } : {}),
    boundAt: options.boundAt
  }
}

/** Fields whose disagreement makes a repeat of the same key a different request, not a retry. */
function reservationBindingMismatches(
  binding: ResourceReservationBinding,
  request: ResourceReservationRequest
): string[] {
  const mismatches: string[] = []
  if (binding.reservationId !== request.reservationId) {
    mismatches.push(`reservationId ${binding.reservationId} != ${request.reservationId}`)
  }
  if (binding.sessionId !== request.sessionId) {
    mismatches.push(`sessionId ${binding.sessionId} != ${request.sessionId}`)
  }
  if (binding.resourceKind !== request.resourceKind) {
    mismatches.push(`resourceKind ${binding.resourceKind} != ${request.resourceKind}`)
  }
  if (binding.ownershipGeneration !== request.ownershipGeneration) {
    mismatches.push(
      `ownershipGeneration ${binding.ownershipGeneration} != ${request.ownershipGeneration}`
    )
  }
  if ((binding.issuer ?? '') !== (request.issuer ?? '')) {
    mismatches.push(`issuer ${binding.issuer ?? '(none)'} != ${request.issuer ?? '(none)'}`)
  }
  return mismatches
}

export function resourceReservationBindingMatchesRequest(
  binding: ResourceReservationBinding,
  request: ResourceReservationRequest
): boolean {
  return binding.key === request.key && reservationBindingMismatches(binding, request).length === 0
}

/** Refusal text for a reused key whose binding disagrees — never returned as a successful replay. */
export function describeResourceReservationConflict(
  binding: ResourceReservationBinding,
  request: ResourceReservationRequest,
  resourceId: string
): string {
  const mismatches = reservationBindingMismatches(binding, request)
  return `Reservation key "${request.key}" is already bound to ${binding.resourceKind} ${resourceId} with a different binding (${mismatches.join('; ')}). Reservation keys are single-use.`
}
