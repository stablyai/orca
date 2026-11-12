import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'

describe('agent status cleanup for a lost SSH connection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clears one connection in one update while preserving newer and unstamped rows', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const oldA = 'tab-a:11111111-1111-4111-8111-111111111111'
    const secondA = 'tab-a2:22222222-2222-4222-8222-222222222222'
    const newerA = 'tab-new:33333333-3333-4333-8333-333333333333'
    const siblingB = 'tab-b:44444444-4444-4444-8444-444444444444'
    const unstamped = 'tab-legacy:55555555-5555-4555-8555-555555555555'
    const local = 'tab-local:66666666-6666-4666-8666-666666666666'
    for (const [paneKey, updatedAt, connectionId] of [
      [oldA, 10, 'ssh-a'],
      [secondA, 20, 'ssh-a'],
      [newerA, 31, 'ssh-a'],
      [siblingB, 15, 'ssh-b']
    ] as const) {
      store
        .getState()
        .setAgentStatus(
          paneKey,
          { state: 'working', prompt: paneKey, agentType: 'codex' },
          undefined,
          { updatedAt },
          { connectionId }
        )
    }
    store
      .getState()
      .setAgentStatus(
        unstamped,
        { state: 'working', prompt: 'legacy', agentType: 'claude' },
        undefined,
        { updatedAt: 5 }
      )
    store
      .getState()
      .setAgentStatus(
        local,
        { state: 'working', prompt: 'local', agentType: 'codex' },
        undefined,
        { updatedAt: 6 },
        { connectionId: null }
      )
    store.setState({
      agentLaunchConfigByPaneKey: {
        [oldA]: {
          launchConfig: { agentCommand: 'codex', agentArgs: '--full-auto', agentEnv: {} },
          registeredAt: 1,
          identity: {}
        }
      },
      acknowledgedAgentsByPaneKey: { [oldA]: 2 }
    })
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {})

    store.getState().clearTransientAgentStatuses('ssh-a', 30)

    unsubscribe()
    expect(subscriber).toHaveBeenCalledOnce()
    expect(queueMicrotaskSpy).toHaveBeenCalledOnce()
    expect(store.getState().agentStatusByPaneKey.get(oldA)).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey.get(secondA)).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey.get(newerA)).toBeDefined()
    expect(store.getState().agentStatusByPaneKey.get(siblingB)).toBeDefined()
    expect(store.getState().agentStatusByPaneKey.get(unstamped)).toBeDefined()
    expect(store.getState().agentStatusByPaneKey.get(local)?.connectionId).toBeNull()
    expect(store.getState().agentLaunchConfigByPaneKey[oldA]).toBeDefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[oldA]).toBe(2)
  })

  it('does not clear a live row on another host that shares a repo id', () => {
    // Repo IDs/buckets collide across hosts; resolve worktree ownership before clearing (#9030).
    vi.useFakeTimers()
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'shared',
          path: '/a',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-a'
        },
        {
          id: 'shared',
          path: '/b',
          displayName: 'B',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-b'
        }
      ],
      worktreesByRepo: {
        shared: [
          { id: 'wt-a', repoId: 'shared', hostId: 'ssh:ssh-a' },
          { id: 'wt-b', repoId: 'shared', hostId: 'ssh:ssh-b' }
        ]
      }
    } as unknown as Partial<AppState>)

    const orphanA = 'tab-a:11111111-1111-4111-8111-111111111111'
    const liveB = 'tab-b:22222222-2222-4222-8222-222222222222'
    store
      .getState()
      .setAgentStatus(
        orphanA,
        { state: 'working', prompt: 'orphan', agentType: 'codex' },
        undefined,
        { updatedAt: 10 },
        { worktreeId: 'wt-a' }
      )
    store
      .getState()
      .setAgentStatus(
        liveB,
        { state: 'working', prompt: 'live b', agentType: 'codex' },
        undefined,
        { updatedAt: 10 },
        { worktreeId: 'wt-b' }
      )

    store.getState().clearTransientAgentStatuses('ssh-a', 30)

    expect(store.getState().agentStatusByPaneKey.get(orphanA)).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey.get(liveB)).toBeDefined()
  })

  it('does not clear a live row whose worktree id collides across hosts', () => {
    // repoId::path collides across hosts: explicit other-host stamps win, unstamped collided rows stay ambiguous and must survive (#9030).
    vi.useFakeTimers()
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'shared',
          path: '/p',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-a'
        },
        {
          id: 'shared',
          path: '/p',
          displayName: 'B',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-b'
        }
      ],
      worktreesByRepo: {
        shared: [
          { id: 'shared::/p', repoId: 'shared', hostId: 'ssh:ssh-a' },
          { id: 'shared::/p', repoId: 'shared', hostId: 'ssh:ssh-b' }
        ]
      }
    } as unknown as Partial<AppState>)

    const liveOnB = 'tab-b:11111111-1111-4111-8111-111111111111'
    const collidedOrphan = 'tab-x:22222222-2222-4222-8222-222222222222'
    // Live agent explicitly on the OTHER host — an old-but-quiet update, before the cutoff.
    store
      .getState()
      .setAgentStatus(
        liveOnB,
        { state: 'working', prompt: 'live b', agentType: 'codex' },
        undefined,
        { updatedAt: 10 },
        { connectionId: 'ssh-b', worktreeId: 'shared::/p' }
      )
    // Unstamped row on the collided id — host can't be proven, so it must be left alone.
    store
      .getState()
      .setAgentStatus(
        collidedOrphan,
        { state: 'working', prompt: 'ambiguous', agentType: 'codex' },
        undefined,
        { updatedAt: 10 },
        { worktreeId: 'shared::/p' }
      )

    store.getState().clearTransientAgentStatuses('ssh-a', 30)

    expect(store.getState().agentStatusByPaneKey.get(liveOnB)).toBeDefined()
    expect(store.getState().agentStatusByPaneKey.get(collidedOrphan)).toBeDefined()
  })
})
