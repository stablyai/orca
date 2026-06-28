import { describe, expect, it, vi } from 'vitest'
import {
  reconcileDeadSessions,
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
})

describe('reconcileDeadSessions', () => {
  function createBinding() {
    return { reconcileIfSessionDead: vi.fn<(liveSessionIds: Set<string>) => void>() }
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
    expect(bindingA.reconcileIfSessionDead).toHaveBeenCalledWith(expectedSet)
    expect(bindingB.reconcileIfSessionDead).toHaveBeenCalledWith(expectedSet)
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
    expect(binding.reconcileIfSessionDead).toHaveBeenCalledWith(new Set())
  })
})
