import { describe, expect, it } from 'vitest'
import {
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR,
  PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR,
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
  it('types a resume against a fresh relay without weakening other owner refusals', () => {
    const session = createSession()

    expect(() =>
      session.admit(
        ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'stale' } }),
        auth('connection-1')
      )
    ).toThrow(
      expect.objectContaining({
        code: PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR,
        message: expect.stringContaining('stale')
      })
    )
  })

  it('activates an authenticated owner only after its publication fence', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    const competitor = session.admit(
      ownerHello({ clientInstanceId: 'client-b' }),
      auth('connection-2', { principal: 'other' })
    )

    expect(first.grant).toMatchObject({
      clientGeneration: 1,
      role: 'session-owner',
      ownerGeneration: 1,
      ownerLease: 'lease-1'
    })
    expect(competitor.grant).toMatchObject({ clientGeneration: 2, role: 'subscriber' })
    first.commitPublication()
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

  it('returns the same generation and lease for duplicate opens on one connection', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    const duplicate = session.admit(ownerHello(), auth('connection-1'))

    expect(duplicate.grant).toBe(first.grant)
    first.commitPublication()
    duplicate.commitPublication()
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

  it('types mismatched recovery without disturbing principal or lease ownership', () => {
    const session = createSession()
    const first = session.admit(ownerHello(), auth('connection-1'))
    first.commitPublication()
    session.close('connection-1')

    expect(() =>
      session.admit(
        ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'lease-1' } }),
        auth('connection-2', { principal: 'stale-desktop' })
      )
    ).toThrow(
      expect.objectContaining({
        code: PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR,
        message: expect.stringContaining('principal')
      })
    )
    expect(() =>
      session.admit(
        ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'wrong' } }),
        auth('connection-3')
      )
    ).toThrow(expect.objectContaining({ code: PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR }))

    const staleFresh = session.admit(
      ownerHello(),
      auth('connection-2', { principal: 'stale-desktop' })
    )
    expect(staleFresh.grant).toMatchObject({ role: 'subscriber' })
    expect(staleFresh.grant.ownerLease).toBeUndefined()

    const recovered = session.admit(
      ownerHello({ resume: { ownerGeneration: 1, ownerLease: 'lease-1' } }),
      auth('connection-4')
    )
    expect(recovered.grant).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2,
      ownerLease: 'lease-1'
    })
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
