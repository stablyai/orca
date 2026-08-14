import { describe, expect, it } from 'vitest'
import {
  PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR,
  PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR,
  PTY_CONSUMER_OWNER_HELD_GRACE_FLOOR_MS,
  PTY_CONSUMER_OWNER_HELD_SELF_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR,
  PtyConsumerSession,
  type PtyConsumerAuthentication,
  type PtyConsumerSessionHello
} from './pty-consumer-session'

function auth(
  connectionId: string,
  overrides: Partial<PtyConsumerAuthentication> = {}
): PtyConsumerAuthentication {
  return {
    connectionId,
    principal: 'desktop',
    authenticated: true,
    allowSessionOwner: true,
    ...overrides
  }
}

function ownerHello(overrides: Partial<PtyConsumerSessionHello> = {}): PtyConsumerSessionHello {
  return {
    clientInstanceId: 'client-a',
    requestedRole: 'session-owner',
    ...overrides
  }
}

function createSession(options: { now?: () => number } = {}): PtyConsumerSession {
  let lease = 0
  return new PtyConsumerSession({
    serverBuildId: 'relay-build',
    createLease: () => `lease-${++lease}`,
    ownerGraceMs: 30_000,
    ...options
  })
}

describe('PtyConsumerSession', () => {
  it('grants a fresh claim when the relay no longer holds the resumed record', () => {
    const session = createSession()

    const admission = session.admit(
      ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'forgotten' } }),
      auth('connection-1')
    )

    // Why one round trip: the client named a record this relay does not have, which is a fresh claim,
    // not a refusal — `resumed: false` is what tells it the old checkpoints no longer apply.
    expect(admission.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 1,
      ownerLease: 'lease-1',
      resumed: false
    })
  })

  it('activates an authenticated owner only after its publication fence', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))

    expect(first.grant).toMatchObject({
      clientGeneration: 1,
      role: 'session-owner',
      ownerGeneration: 1,
      ownerLease: 'lease-1',
      resumed: false
    })
    // Why a coded refusal and not a subscriber grant: a subscriber grant is unusable to a client that
    // asked to own the PTY, and it arrives shaped like success.
    expect(() =>
      session.admit(
        ownerHello({ clientInstanceId: 'client-b' }),
        auth('connection-2', { principal: 'other' })
      )
    ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR }))
    first.commitPublication()

    expect(() =>
      session.admit(
        ownerHello({ clientInstanceId: 'client-b' }),
        auth('connection-3', { principal: 'other' })
      )
    ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR }))
  })

  it('rolls back an unpublished owner without consuming authority', () => {
    const session = createSession()
    session.admit(ownerHello(), auth('failed')).rollbackPublication()

    const retry = session.admit(ownerHello(), auth('retry'))
    expect(retry.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2,
      ownerLease: 'lease-2'
    })
  })

  it('rejects an identical duplicate open before it registers a second publication', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))

    // Why even an identical repeat: two responses settle independently, so one admission cannot make
    // one response's rollback and the other's commit atomic.
    expect(() => session.admit(ownerHello(), auth('connection-1'))).toThrow('only once')
    first.commitPublication()
    expect(session.activeGrant('connection-1')).toBe(first.grant)
  })

  it('rejects a second, different open on one connection', () => {
    const session = createSession()
    session.admit(ownerHello(), auth('connection-1'))

    expect(() =>
      session.admit(ownerHello({ requestedRole: 'subscriber' }), auth('connection-1'))
    ).toThrow('only once')
  })

  it('cannot self-promote an authenticated but owner-ineligible principal', () => {
    const session = createSession()
    const admission = session.admit(
      ownerHello(),
      auth('connection-1', { allowSessionOwner: false })
    )

    expect(admission.grant.role).toBe('subscriber')
    expect(admission.grant.ownerLease).toBeUndefined()
  })

  it('rejects an unauthenticated transport', () => {
    const session = createSession()
    expect(() =>
      session.admit(ownerHello(), auth('connection-1', { authenticated: false }))
    ).toThrow('authentication required')
  })

  it('keeps the lease stable and increments owner generation on valid recovery', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    session.close('connection-1')

    const recovered = session.admit(
      ownerHello({
        resume: {
          ownerGeneration: first.grant.ownerGeneration!,
          ownerLease: first.grant.ownerLease!
        }
      }),
      auth('connection-2')
    )
    recovered.commitPublication()

    expect(recovered.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2,
      ownerLease: 'lease-1'
    })
  })

  it('displaces a still-attached owner that a matching resume proof reclaims', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()

    const recovered = session.admit(
      ownerHello({
        resume: {
          ownerGeneration: first.grant.ownerGeneration!,
          ownerLease: first.grant.ownerLease!
        }
      }),
      auth('connection-2')
    )

    expect(recovered.displacedOwner).toEqual({
      connectionId: 'connection-1',
      grant: first.grant
    })
    // Why: the incumbent keeps authority until the replacement grant is actually published.
    expect(session.activeGrant('connection-1')).toBe(first.grant)

    recovered.commitPublication()
    expect(recovered.grant).toMatchObject({ role: 'session-owner', ownerGeneration: 2 })
    expect(session.activeGrant('connection-1')).toBeNull()
    expect(session.activeGrant('connection-2')).toBe(recovered.grant)
  })

  it('restores the displaced owner when the replacement publication rolls back', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()

    const recovered = session.admit(
      ownerHello({
        resume: {
          ownerGeneration: first.grant.ownerGeneration!,
          ownerLease: first.grant.ownerLease!
        }
      }),
      auth('connection-2')
    )
    recovered.rollbackPublication()

    expect(session.activeGrant('connection-1')).toBe(first.grant)
    expect(session.activeGrant('connection-2')).toBeNull()
    // Why: the restored incumbent must still hold the lease it was admitted with.
    const reclaimed = session.admit(
      ownerHello({
        resume: {
          ownerGeneration: first.grant.ownerGeneration!,
          ownerLease: first.grant.ownerLease!
        }
      }),
      auth('connection-3')
    )
    expect(reclaimed.displacedOwner?.connectionId).toBe('connection-1')
  })

  it('expires a displaced owner restored after its connection already closed', () => {
    let now = 10
    const session = createSession({ now: () => now })
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()

    const recovered = session.admit(
      ownerHello({
        resume: {
          ownerGeneration: first.grant.ownerGeneration!,
          ownerLease: first.grant.ownerLease!
        }
      }),
      auth('connection-2')
    )
    session.close('connection-1')
    recovered.rollbackPublication()

    now += 30_000
    session.sweepExpired()
    const fresh = session.admit(ownerHello(), auth('connection-4'))
    expect(fresh.grant.role).toBe('session-owner')
  })

  it('refuses recovery while the incumbent grant publication is still settling', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))

    expect(() =>
      session.admit(
        ownerHello({
          resume: {
            ownerGeneration: first.grant.ownerGeneration!,
            ownerLease: first.grant.ownerLease!
          }
        }),
        auth('connection-2')
      )
    ).toThrow(
      expect.objectContaining({
        code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
        message: expect.stringContaining('still pending')
      })
    )
  })

  it('fences an old recovery generation after its replacement commits', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    const resume = {
      ownerGeneration: first.grant.ownerGeneration!,
      ownerLease: first.grant.ownerLease!
    }
    const replacement = session.admit(ownerHello({ resume }), auth('connection-2'))

    expect(() => session.admit(ownerHello({ resume }), auth('connection-3'))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR })
    )

    replacement.commitPublication()
    expect(() => session.admit(ownerHello({ resume }), auth('connection-3'))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR })
    )

    const retry = session.admit(
      ownerHello({
        resume: {
          ownerGeneration: replacement.grant.ownerGeneration!,
          ownerLease: replacement.grant.ownerLease!
        }
      }),
      auth('connection-3')
    )

    expect(retry.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 3,
      ownerLease: first.grant.ownerLease
    })
    expect(retry.displacedOwner?.connectionId).toBe('connection-2')
    // Why: the committed replacement already retired the incumbent, so only connection-2 is left to displace.
    expect(session.activeGrant('connection-1')).toBeNull()
  })

  it('accepts an older stable proof after its replacement disconnects', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    const resume = {
      ownerGeneration: first.grant.ownerGeneration!,
      ownerLease: first.grant.ownerLease!
    }
    const replacement = session.admit(ownerHello({ resume }), auth('connection-2'))
    replacement.commitPublication()
    session.close('connection-2')

    const retry = session.admit(ownerHello({ resume }), auth('connection-3'))

    expect(retry.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 3,
      ownerLease: first.grant.ownerLease
    })
  })

  it('retries overlapping recovery against the incumbent after publication rolls back', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    const resume = {
      ownerGeneration: first.grant.ownerGeneration!,
      ownerLease: first.grant.ownerLease!
    }
    const replacement = session.admit(ownerHello({ resume }), auth('connection-2'))

    expect(() => session.admit(ownerHello({ resume }), auth('connection-3'))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR })
    )

    replacement.rollbackPublication()
    const retry = session.admit(ownerHello({ resume }), auth('connection-3'))

    expect(retry.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 3,
      ownerLease: first.grant.ownerLease
    })
    expect(retry.displacedOwner?.connectionId).toBe('connection-1')
    // Why: the rolled-back replacement never published, so it holds no grant the retry could displace.
    expect(session.activeGrant('connection-2')).toBeNull()
  })

  it('separates a disconnected holder from the owner it belongs to', () => {
    let now = 10
    const session = createSession({ now: () => now })
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    session.close('connection-1')

    for (const [connectionId, hello] of [
      ['connection-2', ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'lease-1' } })],
      ['connection-3', ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'wrong' } })],
      ['connection-4', ownerHello()]
    ] as const) {
      expect(() =>
        session.admit(hello, auth(connectionId, { principal: 'other-desktop' }))
      ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR }))
    }

    // Why the incumbent still wins: a matching proof is routed as a replacement and never reaches the
    // held-owner branch, so shortening the grace cannot cost the real owner its lease.
    const recovered = session.admit(
      ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'lease-1' } }),
      auth('connection-5')
    )
    expect(recovered.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2,
      ownerLease: 'lease-1',
      resumed: true
    })
  })

  it('clamps a refused disconnected holder to the shared grace floor', () => {
    let now = 10
    const session = createSession({ now: () => now })
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    // Why 'peer-closed': the floor is only for an owner the relay watched leave.
    session.close('connection-1', 'peer-closed')

    const rival = ownerHello({ clientInstanceId: 'client-b' })
    expect(() => session.admit(rival, auth('connection-2', { principal: 'other' }))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR })
    )
    now += PTY_CONSUMER_OWNER_HELD_GRACE_FLOOR_MS - 1
    expect(() => session.admit(rival, auth('connection-3', { principal: 'other' }))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR })
    )

    now += 1
    const promoted = session.admit(rival, auth('connection-4', { principal: 'other' }))

    expect(promoted.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2,
      ownerLease: 'lease-2',
      resumed: false
    })
  })

  it('keeps the whole grace for an owner the relay tore down for backpressure', () => {
    let now = 1_000
    const session = createSession({ now: () => now })
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    // The relay destroyed this socket because its lane queue was full. That is the signature of an
    // owner that is alive and slow, so the default 'local' cause must leave the grace untouched.
    session.close('connection-1')

    const rival = ownerHello({ clientInstanceId: 'client-b' })
    now += 10
    expect(() => session.admit(rival, auth('connection-2'))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR })
    )
    // Why past the floor and still refused: no owner finishes notice-close, connect, handshake and
    // openClient inside 250 ms, so a floor that applied here would hand the claim away every time.
    now += PTY_CONSUMER_OWNER_HELD_GRACE_FLOOR_MS + 20
    expect(() => session.admit(rival, auth('connection-3'))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR })
    )

    now += 5_000
    const recovered = session.admit(
      ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'lease-1' } }),
      auth('connection-4')
    )

    // The point of the whole sequence: the live owner still gets back in. Losing here is permanent —
    // the refusal it would have received routes as blocked and parks the target with no retry.
    expect(recovered.grant).toMatchObject({
      role: 'session-owner',
      ownerLease: 'lease-1',
      resumed: true
    })
  })

  it("refuses a client's own attached connection as transient, not as another client's claim", () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()

    // The app's previous connection is a half-open zombie the relay never observed closing. Its
    // re-open carries the same instance id and no proof, because the recovery record went with it.
    expect(() => session.admit(ownerHello(), auth('connection-2'))).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_SELF_ERROR })
    )

    // A genuinely different client is still blocked — this narrows the terminal case, it does not
    // remove it.
    expect(() =>
      session.admit(
        ownerHello({ clientInstanceId: 'client-b' }),
        auth('connection-3', { principal: 'other-desktop' })
      )
    ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR }))
    // Same instance id under a different principal is a different client too.
    expect(() =>
      session.admit(ownerHello(), auth('connection-4', { principal: 'other-desktop' }))
    ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR }))
  })

  it('never converts an owner-capable request into a subscriber grant', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()

    const ineligible = session.admit(
      ownerHello(),
      auth('connection-2', { allowSessionOwner: false })
    )

    // Why this is the only subscriber outcome left: the request was not owner-capable in the first
    // place, so no refusal code applies and the grant carries no `resumed`.
    expect(ineligible.grant.role).toBe('subscriber')
    expect(ineligible.grant).not.toHaveProperty('resumed')
    expect(() =>
      session.admit(ownerHello({ clientInstanceId: 'client-b' }), auth('connection-3'))
    ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR }))
  })

  it('elects a new owner after disconnected-owner grace expires', () => {
    let now = 10
    const session = createSession({ now: () => now })
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    session.close('connection-1')
    now += 30_000

    const next = session.admit(
      ownerHello({ clientInstanceId: 'client-b' }),
      auth('connection-2', { principal: 'other' })
    )
    expect(next.grant).toMatchObject({ role: 'session-owner', ownerGeneration: 2 })
  })

  it('intersects V1 capability and clamps its source-unit window', () => {
    const session = new PtyConsumerSession({
      serverBuildId: 'relay-build',
      outputFlowControl: { versions: [1], maxWindowSu: 64 },
      createLease: () => 'lease'
    })
    const admission = session.admit(
      ownerHello({
        capabilities: {
          outputFlowControl: { versions: [1, 2], requestedWindowSu: 128 }
        }
      }),
      auth('connection-1')
    )

    expect(admission.grant.capabilities?.outputFlowControl).toEqual({
      version: 1,
      windowSu: 64
    })
  })

  it('makes token-free bounded legacy an explicit capability omission', () => {
    const session = createSession()
    const admission = session.admit(ownerHello(), auth('connection-1'))

    expect(admission.grant.capabilities).toBeUndefined()
    expect(admission.grant).not.toHaveProperty('deliveryToken')
  })

  it('bounds capability offers before fingerprinting them', () => {
    const session = createSession()
    expect(() =>
      session.admit(
        ownerHello({
          capabilities: {
            outputFlowControl: {
              versions: Array.from({ length: 9 }, (_, index) => index + 1),
              requestedWindowSu: 64
            }
          }
        }),
        auth('connection-1')
      )
    ).toThrow('versions')
  })

  it('rejects invalid server windows and owner grace', () => {
    expect(
      () =>
        new PtyConsumerSession({
          serverBuildId: 'build',
          outputFlowControl: { versions: [1], maxWindowSu: 0 }
        })
    ).toThrow('support')
    expect(
      () => new PtyConsumerSession({ serverBuildId: 'build', ownerGraceMs: Number.MAX_VALUE })
    ).toThrow('ownerGraceMs')
  })
})
