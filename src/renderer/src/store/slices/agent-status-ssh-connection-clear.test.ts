import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppState } from '../types'
import { createTestStore } from './store-test-helpers'

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
      acknowledgedAgentsByPaneKey: { [oldA]: 2 },
      retentionSuppressedPaneKeys: { [oldA]: true }
    } as Partial<AppState>)
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {})

    store.getState().clearTransientAgentStatuses('ssh-a', 30)

    unsubscribe()
    expect(subscriber).toHaveBeenCalledOnce()
    expect(queueMicrotaskSpy).toHaveBeenCalledOnce()
    expect(store.getState().agentStatusByPaneKey[oldA]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[secondA]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[newerA]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[siblingB]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[unstamped]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[local]?.connectionId).toBeNull()
    expect(store.getState().agentLaunchConfigByPaneKey[oldA]).toBeDefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[oldA]).toBe(2)
    expect(store.getState().retentionSuppressedPaneKeys[oldA]).toBe(true)
  })

  it('clears worktree-attributed orphans on the connection even when their connectionId stamp is missing', () => {
    // Why: #9030 — after a relay/daemon restart main drops the rows but renderer entries whose
    // connectionId never matched (unstamped over SSH) stayed "fresh" 30 min and un-clickable;
    // the host is proven via the owning worktree's repo so those orphans clear too.
    vi.useFakeTimers()
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-a',
          path: '/a',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-a'
        },
        {
          id: 'repo-b',
          path: '/b',
          displayName: 'B',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-b'
        }
      ],
      worktreesByRepo: {
        'repo-a': [{ id: 'wt-a', repoId: 'repo-a' }],
        'repo-b': [{ id: 'wt-b', repoId: 'repo-b' }]
      }
    } as unknown as Partial<AppState>)

    const orphanA = 'tab-a:11111111-1111-4111-8111-111111111111'
    const freshOrphanA = 'tab-a2:22222222-2222-4222-8222-222222222222'
    const otherHostB = 'tab-b:33333333-3333-4333-8333-333333333333'
    // Orphan on ssh-a's worktree, no connectionId stamp — the #9030 shape.
    store
      .getState()
      .setAgentStatus(
        orphanA,
        { state: 'working', prompt: 'orphan', agentType: 'codex' },
        undefined,
        { updatedAt: 10 },
        { worktreeId: 'wt-a' }
      )
    // Same host, but updated after the cutoff — a genuinely fresh row must survive.
    store
      .getState()
      .setAgentStatus(
        freshOrphanA,
        { state: 'working', prompt: 'fresh', agentType: 'codex' },
        undefined,
        { updatedAt: 40 },
        { worktreeId: 'wt-a' }
      )
    // Worktree-attributed row on a different live host must be untouched.
    store
      .getState()
      .setAgentStatus(
        otherHostB,
        { state: 'working', prompt: 'other host', agentType: 'codex' },
        undefined,
        { updatedAt: 10 },
        { worktreeId: 'wt-b' }
      )

    store.getState().clearTransientAgentStatuses('ssh-a', 30)

    expect(store.getState().agentStatusByPaneKey[orphanA]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[freshOrphanA]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[otherHostB]).toBeDefined()
  })

  it('does not clear a live row on another host that shares a repo id', () => {
    // Why: a repo id can live on multiple hosts and share one worktreesByRepo bucket; scoping by bare
    // repo id would clear the other host's live rows, so ownership must come from the worktree (#9030).
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

    expect(store.getState().agentStatusByPaneKey[orphanA]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[liveB]).toBeDefined()
  })

  it('does not clear a live row whose worktree id collides across hosts', () => {
    // Why: worktree id is `${repoId}::${path}` with no host component, so the same project mirrored at
    // the same path on two hosts shares one id. An explicit stamp for the other host must win, and an
    // unstamped row on a collided id is ambiguous — left alone rather than hiding a live row (#9030).
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

    expect(store.getState().agentStatusByPaneKey[liveOnB]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[collidedOrphan]).toBeDefined()
  })

  it('retains an accepted connection stamp across later unstamped pings', () => {
    const store = createTestStore()
    const paneKey = 'tab-a:11111111-1111-4111-8111-111111111111'
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'first', agentType: 'codex' },
        undefined,
        { updatedAt: 1 },
        { connectionId: 'ssh-a' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'ping', agentType: 'codex' },
        undefined,
        { updatedAt: 2 }
      )

    expect(store.getState().agentStatusByPaneKey[paneKey]?.connectionId).toBe('ssh-a')
  })

  it('blocks renderer callbacks at clear time until a later reconnect', () => {
    const store = createTestStore()

    store.getState().clearTransientAgentStatuses('ssh-a', 10)

    expect(store.getState().transientClearedAgentStatusConnectionIds['ssh-a']).toBe(true)
    store.getState().setSshConnectionState('ssh-a', {
      targetId: 'ssh-a',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })
    expect(store.getState().transientClearedAgentStatusConnectionIds['ssh-a']).toBe(true)

    store.getState().setSshConnectionState('ssh-a', {
      targetId: 'ssh-a',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    expect(store.getState().transientClearedAgentStatusConnectionIds['ssh-a']).toBeUndefined()
  })

  it('moves a colliding pane to newer authoritative ownership', () => {
    const store = createTestStore()
    const paneKey = 'tab-a:11111111-1111-4111-8111-111111111111'
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'host a', agentType: 'codex' },
        undefined,
        { updatedAt: 1 },
        { connectionId: 'ssh-a' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'host b', agentType: 'codex' },
        undefined,
        { updatedAt: 2 },
        { connectionId: 'ssh-b' }
      )

    store.getState().clearTransientAgentStatuses('ssh-a', 3)

    expect(store.getState().agentStatusByPaneKey[paneKey]).toMatchObject({
      prompt: 'host b',
      connectionId: 'ssh-b'
    })
  })
})
