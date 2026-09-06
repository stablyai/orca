import { describe, expect, it } from 'vitest'
import {
  ResourceReservationRequestSchema,
  buildResourceReservationBinding,
  describeResourceReservationConflict,
  resourceReservationBindingMatchesRequest,
  type ResourceReservationRequest
} from './resource-reservation-binding'

function request(overrides: Partial<ResourceReservationRequest> = {}): ResourceReservationRequest {
  return {
    key: 'key-1',
    reservationId: 'res-1',
    sessionId: 'session-1',
    resourceKind: 'worktree',
    ownershipGeneration: 3,
    issuer: 'openloop',
    ...overrides
  }
}

describe('resource reservation binding identity', () => {
  it('treats a byte-identical repeat as the same request, not a second use', () => {
    const binding = buildResourceReservationBinding(request(), { boundAt: 100 })

    expect(resourceReservationBindingMatchesRequest(binding, request())).toBe(true)
  })

  it.each([
    ['reservationId', { reservationId: 'res-2' }],
    ['sessionId', { sessionId: 'session-2' }],
    ['ownershipGeneration', { ownershipGeneration: 4 }],
    ['issuer', { issuer: 'other' }]
  ])('refuses a repeat whose %s disagrees', (_field, overrides) => {
    const binding = buildResourceReservationBinding(request(), { boundAt: 100 })

    expect(resourceReservationBindingMatchesRequest(binding, request(overrides))).toBe(false)
  })

  it('never lets a client clock set the bind time', () => {
    const binding = buildResourceReservationBinding(
      { ...request(), boundAt: 1 } as ResourceReservationRequest,
      { boundAt: 999 }
    )

    expect(binding.boundAt).toBe(999)
  })

  it('names the resource and the disagreeing fields in the conflict text', () => {
    const binding = buildResourceReservationBinding(request(), { boundAt: 100 })

    const message = describeResourceReservationConflict(
      binding,
      request({ sessionId: 'session-2' }),
      'repo-1::/tmp/wt'
    )

    expect(message).toContain('repo-1::/tmp/wt')
    expect(message).toContain('sessionId session-1 != session-2')
    expect(message).toContain('single-use')
  })
})

describe('resource reservation request schema', () => {
  it('rejects a fractional ownership generation', () => {
    expect(
      ResourceReservationRequestSchema.safeParse(request({ ownershipGeneration: 1.5 })).success
    ).toBe(false)
  })

  it('rejects an unknown resource kind', () => {
    expect(
      ResourceReservationRequestSchema.safeParse({
        ...request(),
        resourceKind: 'automation'
      }).success
    ).toBe(false)
  })

  it('accepts a binding with no issuer', () => {
    const parsed = ResourceReservationRequestSchema.safeParse({
      key: 'k',
      reservationId: 'r',
      sessionId: 's',
      resourceKind: 'terminal',
      ownershipGeneration: 0
    })

    expect(parsed.success).toBe(true)
  })
})
