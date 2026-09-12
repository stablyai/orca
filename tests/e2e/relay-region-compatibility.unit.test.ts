import { describe, expect, it, vi } from 'vitest'
import {
  AssignmentRequestSchema as BaselineRequest,
  AssignmentResponseSchema as BaselineResponse
} from '../../cloud/apps/relay/src/test-fixtures/relay-contract-baseline/director-messages'
import {
  DrainSchema as BaselineDrain,
  HostHelloSchema as BaselineHello
} from '../../cloud/apps/relay/src/test-fixtures/relay-contract-baseline/control-messages'
import { AssignmentRequestSchema } from '../../cloud/packages/relay-contract/src/director-messages'
import { HostHelloSchema } from '../../cloud/packages/relay-contract/src/control-messages'
import { requestRelayAssignment } from '../../src/main/runtime/relay/relay-http-client'
import { RelayAssignRateGate } from '../../src/main/runtime/relay/relay-assign-rate-gate'

const assignment = {
  v: 1,
  cellUrl: 'https://asia.example.test',
  assignmentEpoch: 3,
  lease: 'synthetic-assignment'
}
const window = {
  generation: 1,
  assignmentEpoch: 3,
  incumbentRegion: 'asia-east2',
  expiresAt: 100_000_000,
  policyVersion: 1
}
function request(fetch: typeof globalThis.fetch) {
  return requestRelayAssignment({
    directorUrl: 'https://director.example.test',
    relayHostId: 'abcdefghijklmnop',
    relayToken: 'synthetic-authorization',
    preferredRegion: 'asia-east2',
    reconnect: true,
    regionCorrection: { v: 1, action: 'issue-window' },
    fetch,
    assignRateGate: new RelayAssignRateGate()
  })
}

describe('relay correction mixed-version wire contracts', () => {
  it('new desktop falls back against the actual pinned old director parser', async () => {
    const bodies: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body))
      bodies.push(body)
      return BaselineRequest.safeParse(body).success
        ? Response.json(BaselineResponse.parse(assignment))
        : new Response(null, { status: 400 })
    })
    expect(await request(fetch)).toEqual(assignment)
    expect(bodies).toHaveLength(2)
    expect(AssignmentRequestSchema.safeParse(bodies[0]).success).toBe(true)
    expect(BaselineRequest.safeParse(bodies[0]).success).toBe(false)
    expect(bodies[1]).toEqual({
      v: 1,
      relayHostId: 'abcdefghijklmnop',
      preferredRegion: 'asia-east2',
      reconnect: true
    })
  })

  it('the old desktop assignment shape remains accepted by the new director', () => {
    const request = BaselineRequest.parse({ v: 1, relayHostId: 'abcdefghijklmnop' })
    expect(AssignmentRequestSchema.parse(request)).toEqual(request)
    expect(BaselineResponse.parse(assignment)).toEqual(assignment)
  })

  it('the negotiated capability requires no change to the strict old host hello', () => {
    const hello = {
      v: 1,
      relayHostId: 'abcdefghijklmnop',
      assignmentEpoch: 3,
      hostPublicKeyB64: Buffer.alloc(32).toString('base64'),
      appVersion: 'test'
    }
    expect(BaselineHello.parse(HostHelloSchema.parse(hello))).toEqual(hello)
    expect(BaselineHello.safeParse({ ...hello, idleRegionalRehome: true }).success).toBe(
      false
    )
  })

  it('the idle cutover uses a drain frame understood by the pinned old desktop', () => {
    const drain = { recovery: 'resolve-director', graceMs: 0 }
    expect(BaselineDrain.parse(drain)).toEqual(drain)
  })

  it.each([
    { v: 1, window: { ...window, policyVersion: 2 } },
    { v: 2, window },
    { v: 1, window: { ...window, expiresAt: -1 } },
    { v: 1, window: { ...window, unexpectedField: true } }
  ])(
    'defers unsupported or malformed optional correction without losing placement: %j',
    async (regionCorrection) => {
      const result = await request(async () => Response.json({ ...assignment, regionCorrection }))
      expect(result).toMatchObject(assignment)
      expect(result.regionCorrection).toBeUndefined()
    }
  )

  it('still accepts supported correction metadata', async () => {
    const regionCorrection = { v: 1, window }
    expect(await request(async () => Response.json({ ...assignment, regionCorrection }))).toEqual({
      ...assignment,
      regionCorrection
    })
  })

  it.each([
    { cellUrl: 'http://untrusted.example.test' },
    { assignmentEpoch: -1 },
    { lease: '' },
    { unexpectedField: true }
  ])('keeps the core assignment strict: %j', async (invalid) => {
    await expect(request(async () => Response.json({ ...assignment, ...invalid }))).rejects.toThrow(
      'relay_assignment_failed_502'
    )
  })
})
