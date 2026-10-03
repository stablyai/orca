import { describe, expect, it, vi } from 'vitest'
import {
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PtyConsumerSession,
  type PtyConsumerAuthentication,
  type PtyConsumerSessionHello
} from './pty-consumer-session'

function authentication(overrides: Partial<PtyConsumerAuthentication> = {}) {
  return {
    connectionId: 'successor',
    principal: 'desktop',
    authenticated: true,
    allowSessionOwner: true,
    ...overrides
  }
}

function hello(overrides: Partial<PtyConsumerSessionHello> = {}): PtyConsumerSessionHello {
  return {
    clientInstanceId: 'client-a',
    requestedRole: 'session-owner',
    resume: { ownerGeneration: 1, ownerLease: 'lease-1' },
    ...overrides
  }
}

function fixture() {
  let now = 0
  let lease = 0
  const createLease = vi.fn(() => `lease-${++lease}`)
  const session = new PtyConsumerSession({
    serverBuildId: 'relay-build',
    createLease,
    ownerGraceMs: 30_000,
    now: () => now
  })
  return { session, createLease, advance: () => (now += 30_001) }
}

function activate(session: PtyConsumerSession) {
  const admission = session.admit(
    hello({ resume: undefined }),
    authentication({ connectionId: 'source' })
  )
  admission.commitPublication()
  return admission
}

describe('PtyConsumerSession resume-only admission', () => {
  it('does not shorten disconnected-owner grace after a refused strict claim', () => {
    let now = 0
    const session = new PtyConsumerSession({
      serverBuildId: 'relay-build',
      ownerGraceMs: 30_000,
      createLease: () => 'lease-1',
      now: () => now
    })
    activate(session)
    session.close('source', 'peer-closed')
    expect(() =>
      session.admitResumed(
        hello({ resume: { ownerGeneration: 1, ownerLease: 'wrong' } }),
        authentication()
      )
    ).toThrow()
    now = 1_000
    expect(session.admitResumed(hello(), authentication()).grant.resumed).toBe(true)
  })
  it('refuses a missing owner without minting a lease or consuming generations or the connection', () => {
    const { session, createLease } = fixture()
    expect(() => session.admitResumed(hello(), authentication())).toThrow(
      'pty_consumer_resume_owner_missing'
    )
    expect(createLease).not.toHaveBeenCalled()
    expect(session.activeGrant('successor')).toBeNull()
    const ordinary = session.admit(hello(), authentication())
    expect(ordinary.grant).toMatchObject({
      resumed: false,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'lease-1'
    })
    expect(createLease).toHaveBeenCalledTimes(1)
  })

  it('publishes a valid resumed owner atomically without minting a new lease', () => {
    const { session, createLease } = fixture()
    const source = activate(session)
    const successor = session.admitResumed(hello(), authentication())
    expect(successor.grant).toMatchObject({
      resumed: true,
      ownerGeneration: 2,
      clientGeneration: 2,
      ownerLease: 'lease-1'
    })
    expect(successor.displacedOwner).toEqual({ connectionId: 'source', grant: source.grant })
    expect(session.activeGrant('source')).toBe(source.grant)
    expect(session.activeGrant('successor')).toBeNull()
    successor.commitPublication()
    expect(session.activeGrant('source')).toBeNull()
    expect(session.activeGrant('successor')).toBe(successor.grant)
    expect(createLease).toHaveBeenCalledTimes(1)
  })

  it('restores the incumbent on rollback and permits retry on the same connection', () => {
    const { session } = fixture()
    const source = activate(session)
    const successor = session.admitResumed(hello(), authentication())
    successor.rollbackPublication()
    successor.commitPublication()
    expect(session.activeGrant('source')).toBe(source.grant)
    expect(session.activeGrant('successor')).toBeNull()
    const retry = session.admitResumed(hello(), authentication())
    expect(retry.grant).toMatchObject({ resumed: true, ownerGeneration: 3, ownerLease: 'lease-1' })
    retry.commitPublication()
    expect(session.activeGrant('successor')).toBe(retry.grant)
  })

  it.each([
    ['lease', hello({ resume: { ownerGeneration: 1, ownerLease: 'wrong' } }), authentication()],
    ['client', hello({ clientInstanceId: 'other' }), authentication()],
    ['principal', hello(), authentication({ principal: 'other' })],
    [
      'generation',
      hello({ resume: { ownerGeneration: 99, ownerLease: 'lease-1' } }),
      authentication()
    ]
  ])(
    'refuses a wrong %s without disturbing the owner or consuming the connection',
    (_name, request, auth) => {
      const { session, createLease } = fixture()
      const source = activate(session)
      expect(() => session.admitResumed(request, auth)).toThrow()
      expect(session.activeGrant('source')).toBe(source.grant)
      const valid = session.admitResumed(hello(), authentication())
      expect(valid.grant).toMatchObject({ resumed: true, clientGeneration: 2, ownerGeneration: 2 })
      expect(createLease).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses expired ownership while leaving ordinary fresh-claim fallback intact', () => {
    const { session, createLease, advance } = fixture()
    activate(session)
    session.close('source')
    advance()
    expect(() => session.admitResumed(hello(), authentication())).toThrow(
      'pty_consumer_resume_owner_missing'
    )
    expect(createLease).toHaveBeenCalledTimes(1)
    expect(session.admit(hello(), authentication()).grant).toMatchObject({
      resumed: false,
      clientGeneration: 2,
      ownerGeneration: 2,
      ownerLease: 'lease-2'
    })
  })

  it.each([
    [
      'missing proof',
      hello({ resume: undefined }),
      authentication(),
      'pty_consumer_resume_required'
    ],
    [
      'subscriber',
      hello({ requestedRole: 'subscriber' }),
      authentication(),
      'pty_consumer_resume_required'
    ],
    [
      'owner-ineligible',
      hello(),
      authentication({ allowSessionOwner: false }),
      'pty_consumer_resume_required'
    ],
    [
      'unauthenticated',
      hello(),
      authentication({ authenticated: false }),
      'authentication required'
    ]
  ])('refuses %s without reserving the connection', (_name, request, auth, error) => {
    const { session } = fixture()
    activate(session)
    expect(() => session.admitResumed(request, auth)).toThrow(error)
    expect(session.admitResumed(hello(), authentication()).grant).toMatchObject({
      resumed: true,
      clientGeneration: 2,
      ownerGeneration: 2
    })
  })

  it('preserves pending-recovery refusal and permits retry after rollback', () => {
    const { session } = fixture()
    const source = activate(session)
    const pending = session.admitResumed(hello(), authentication({ connectionId: 'pending' }))
    expect(() => session.admitResumed(hello(), authentication())).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR })
    )
    expect(session.activeGrant('source')).toBe(source.grant)
    pending.rollbackPublication()
    const retry = session.admitResumed(hello(), authentication())
    expect(retry.grant).toMatchObject({ resumed: true, clientGeneration: 3, ownerGeneration: 3 })
    retry.commitPublication()
    expect(session.activeGrant('source')).toBeNull()
  })

  it('recovers a disconnected owner within grace', () => {
    const { session } = fixture()
    activate(session)
    session.close('source')
    const successor = session.admitResumed(hello(), authentication())
    expect(successor.displacedOwner).toBeUndefined()
    expect(successor.grant).toMatchObject({
      resumed: true,
      ownerGeneration: 2,
      ownerLease: 'lease-1'
    })
    successor.commitPublication()
    expect(session.activeGrant('successor')).toBe(successor.grant)
  })

  it('recovers the last durable generation only after the unpersisted successor disconnects', () => {
    const { session, createLease } = fixture()
    activate(session)
    const first = session.admitResumed(hello(), authentication())
    first.commitPublication()
    const retryAuthentication = authentication({ connectionId: 'retry' })
    expect(() => session.admitResumed(hello(), retryAuthentication)).toThrow('superseded')
    session.close('successor', 'peer-closed')
    const retry = session.admitResumed(hello(), retryAuthentication)
    expect(retry.grant).toMatchObject({ resumed: true, ownerGeneration: 3, ownerLease: 'lease-1' })
    retry.commitPublication()
    expect(createLease).toHaveBeenCalledOnce()
    expect(session.activeGrant('retry')).toBe(retry.grant)
  })
})
