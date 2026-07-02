import { describe, expect, it, vi } from 'vitest'
import {
  reconcileDeadSessions,
  reconcileMissingSessions,
  shouldReconcileDeadSession,
  shouldReconcileMissingSession
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
    // Why (regression): the snapshot predates this binding (boundAt >= requestedAt),
    // so the fresh ptyId's absence from it is meaningless — it cannot prove death.
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
    // Why: the guard is inclusive (>=) — a coarse/clamped performance.now() can
    // land a same-tick bind and request, and that newborn must still be kept.
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
    // Omitted snapshotRequestedAt: behave exactly as today.
    expect(
      shouldReconcileDeadSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        liveSessionIds: new Set(['wt@@alive']),
        ptyBoundAt: 1000
      })
    ).toBe(true)
    // Omitted ptyBoundAt (null): behave exactly as today.
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
  it('reconciles only on an authoritative false liveness result', () => {
    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@dead',
        connectionId: null,
        isLive: false
      })
    ).toBe(true)
    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@maybe',
        connectionId: null,
        isLive: null
      })
    ).toBe(false)
    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@live',
        connectionId: null,
        isLive: true
      })
    ).toBe(false)
  })

  it('keeps SSH, remote, and newborn bindings safe for missing-session checks', () => {
    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@ssh',
        connectionId: 'ssh-1',
        isLive: false
      })
    ).toBe(false)
    expect(
      shouldReconcileMissingSession({
        ptyId: 'remote:env-1:abc',
        connectionId: null,
        isLive: false
      })
    ).toBe(false)
    expect(
      shouldReconcileMissingSession({
        ptyId: 'wt@@newborn',
        connectionId: null,
        isLive: false,
        ptyBoundAt: 100,
        livenessRequestedAt: 100
      })
    ).toBe(false)
  })
})

describe('reconcileDeadSessions', () => {
  function createBinding() {
    return {
      reconcileIfSessionDead:
        vi.fn<(liveSessionIds: Set<string>, snapshotRequestedAt?: number) => void>()
    }
  }

  it('invokes each binding with the resolved live-session id set', async () => {
    const bindingA = createBinding()
    const bindingB = createBinding()
    await reconcileDeadSessions({
      bindings: [bindingA, bindingB],
      listSessions: async () => [
        { id: 'wt@@alive', cwd: '/a', title: 'a' },
        { id: 'wt@@other', cwd: '/b', title: 'b' }
      ]
    })
    const expectedSet = new Set(['wt@@alive', 'wt@@other'])
    expect(bindingA.reconcileIfSessionDead).toHaveBeenCalledWith(expectedSet, expect.any(Number))
    expect(bindingB.reconcileIfSessionDead).toHaveBeenCalledWith(expectedSet, expect.any(Number))
  })

  it('treats a rejected listSessions as "unknown" and reconciles nothing', async () => {
    const binding = createBinding()
    await reconcileDeadSessions({
      bindings: [binding],
      listSessions: async () => {
        throw new Error('IPC failed')
      }
    })
    expect(binding.reconcileIfSessionDead).not.toHaveBeenCalled()
  })

  it('treats a resolved empty list as authoritative (still reconciles)', async () => {
    const binding = createBinding()
    await reconcileDeadSessions({
      bindings: [binding],
      listSessions: async () => []
    })
    expect(binding.reconcileIfSessionDead).toHaveBeenCalledWith(new Set(), expect.any(Number))
  })

  it('forwards a requestedAt timestamp captured before listSessions resolves', async () => {
    // Why (fail-open guard): if requestedAt is not threaded, a fresh pane bound
    // after the request is wrongly reconciled. Prove a Number reaches each binding
    // and that it predates a post-call now (captured before, not after, resolve).
    const binding = createBinding()
    const before = performance.now()
    await reconcileDeadSessions({
      bindings: [binding],
      listSessions: async () => [{ id: 'wt@@alive', cwd: '/a', title: 'a' }]
    })
    const after = performance.now()
    expect(binding.reconcileIfSessionDead).toHaveBeenCalledTimes(1)
    const [, requestedAt] = binding.reconcileIfSessionDead.mock.calls[0]!
    expect(typeof requestedAt).toBe('number')
    expect(requestedAt).toBeGreaterThanOrEqual(before)
    expect(requestedAt).toBeLessThanOrEqual(after)
  })
})

describe('reconcileMissingSessions', () => {
  it('invokes each binding with targeted liveness and a shared request timestamp', () => {
    const bindingA = {
      reconcileIfSessionMissing:
        vi.fn<(hasPty: (ptyId: string) => Promise<boolean | null>, requestedAt?: number) => void>()
    }
    const bindingB = {
      reconcileIfSessionMissing:
        vi.fn<(hasPty: (ptyId: string) => Promise<boolean | null>, requestedAt?: number) => void>()
    }
    const hasPty = vi.fn(async () => true)

    reconcileMissingSessions({ bindings: [bindingA, bindingB], hasPty })

    expect(bindingA.reconcileIfSessionMissing).toHaveBeenCalledWith(hasPty, expect.any(Number))
    expect(bindingB.reconcileIfSessionMissing).toHaveBeenCalledWith(hasPty, expect.any(Number))
    expect(bindingA.reconcileIfSessionMissing.mock.calls[0]?.[1]).toBe(
      bindingB.reconcileIfSessionMissing.mock.calls[0]?.[1]
    )
    expect(hasPty).not.toHaveBeenCalled()
  })
})
