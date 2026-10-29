import { describe, expect, it, vi } from 'vitest'
import {
  reconcileMissingSessions,
  shouldReconcileMissingSession,
  shouldReconcileDeadSession
} from './terminal-dead-session-reconcile'

describe('shouldReconcileDeadSession', () => {
  it('reconciles a local, non-remote id genuinely absent from the live set', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive'])
      })
    ).toBe(true)
  })

  it('does not reconcile when the bound id is still live', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@alive',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive'])
      })
    ).toBe(false)
  })

  it('skips a mid-spawn pane with no bound id', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: null,
        connectionId: null,
        liveSessionIds: new Set()
      })
    ).toBe(false)
  })

  it('skips remote: web-runtime ids', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'remote:env-1:abc',
        connectionId: null,
        liveSessionIds: new Set()
      })
    ).toBe(false)
  })

  it('skips SSH/non-local ids (non-null connectionId)', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@ssh-dead',
        connectionId: 'ssh-target-1',
        liveSessionIds: new Set(['wt@@alive'])
      })
    ).toBe(false)
  })

  it('reconciles a genuinely-absent local id even when the live set is empty (no zero-total skip)', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        liveSessionIds: new Set()
      })
    ).toBe(true)
  })

  it('does NOT reconcile a newborn pane bound after the snapshot was requested', () => {
    // A snapshot requested before this bind cannot prove the newborn PTY dead.
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@newborn',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive']),
        ptyBoundAt: 1000,
        snapshotRequestedAt: 900
      })
    ).toBe(false)
  })

  it('does NOT reconcile when the binding and snapshot request share a tick (boundAt === requestedAt)', () => {
    // Coarse performance.now can tie request and bind; inclusive comparison must retain that newborn.
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@newborn',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive']),
        ptyBoundAt: 1000,
        snapshotRequestedAt: 1000
      })
    ).toBe(false)
  })

  it('reconciles when the binding predates the snapshot request (boundAt < requestedAt)', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive']),
        ptyBoundAt: 900,
        snapshotRequestedAt: 1000
      })
    ).toBe(true)
  })

  it('ignores the freshness guard when either timestamp is omitted (back-compat)', () => {
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive']),
        ptyBoundAt: 1000
      })
    ).toBe(true)
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive']),
        ptyBoundAt: null,
        snapshotRequestedAt: 1000
      })
    ).toBe(true)
  })
})

describe('shouldReconcileMissingSession', () => {
  it('reconciles only an authoritative missing local PTY', () => {
    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        isLive: false
      })
    ).toBe(true)

    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@alive',
        connectionId: null,
        isLive: true
      })
    ).toBe(false)

    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@unknown',
        connectionId: null,
        isLive: null
      })
    ).toBe(false)
  })

  it('keeps the remote, SSH, and newborn guards from the broad reconcile path', () => {
    expect(
      shouldReconcileMissingSession({
        ptyId: 'remote:env-1:abc',
        connectionId: null,
        isLive: false
      })
    ).toBe(false)

    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@ssh-dead',
        connectionId: 'ssh-target-1',
        isLive: false
      })
    ).toBe(false)

    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@newborn',
        connectionId: null,
        isLive: false,
        ptyBoundAt: 1000,
        livenessRequestedAt: 900
      })
    ).toBe(false)
  })
})

describe('reconcileMissingSessions', () => {
  it('invokes each binding with the targeted liveness probe and request timestamp', () => {
    const hasPty = vi.fn(async () => true)
    const bindingA = { reconcileIfSessionMissing: vi.fn() }
    const bindingB = { reconcileIfSessionMissing: vi.fn() }
    const before = performance.now()

    reconcileMissingSessions({ bindings: [bindingA, bindingB], hasPty })

    const after = performance.now()
    expect(bindingA.reconcileIfSessionMissing).toHaveBeenCalledWith(hasPty, expect.any(Number))
    expect(bindingB.reconcileIfSessionMissing).toHaveBeenCalledWith(hasPty, expect.any(Number))
    const [, requestedAt] = bindingA.reconcileIfSessionMissing.mock.calls[0]!
    expect(requestedAt).toBeGreaterThanOrEqual(before)
    expect(requestedAt).toBeLessThanOrEqual(after)
  })
})
