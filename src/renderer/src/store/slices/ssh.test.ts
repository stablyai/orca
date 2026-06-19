import { describe, expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { createTestStore, makeTab, makeWorktree, TEST_REPO } from './store-test-helpers'

describe('createSshSlice', () => {
  it('clears renderer state and deferred reconnect metadata for a removed SSH target', () => {
    const store = createTestStore()
    const targetId = 'ssh-1'
    const otherTargetId = 'ssh-2'
    const worktreeId = 'repo-ssh::/remote/project'
    const otherWorktreeId = 'repo-other::/remote/project'
    const removedPtyId = toAppSshPtyId(targetId, 'pty-live')
    const staleLastKnownPtyId = toAppSshPtyId(targetId, 'pty-last-known')
    const otherPtyId = toAppSshPtyId(otherTargetId, 'pty-other')

    store.setState({
      repos: [
        { ...TEST_REPO, id: 'repo-ssh', connectionId: targetId },
        { ...TEST_REPO, id: 'repo-other', connectionId: otherTargetId }
      ],
      worktreesByRepo: {
        'repo-ssh': [makeWorktree({ id: worktreeId, repoId: 'repo-ssh' })],
        'repo-other': [makeWorktree({ id: otherWorktreeId, repoId: 'repo-other' })]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'tab-ssh',
            worktreeId,
            ptyId: removedPtyId,
            pendingActivationSpawn: true
          })
        ],
        [otherWorktreeId]: [
          makeTab({ id: 'tab-other', worktreeId: otherWorktreeId, ptyId: otherPtyId }),
          makeTab({ id: 'tab-stale-last-known', worktreeId: otherWorktreeId })
        ]
      },
      ptyIdsByTabId: {
        'tab-ssh': [removedPtyId],
        'tab-other': [otherPtyId]
      },
      lastKnownRelayPtyIdByTabId: {
        'tab-ssh': removedPtyId,
        'tab-stale-last-known': staleLastKnownPtyId,
        'tab-other': otherPtyId
      },
      pendingCodexPaneRestartIds: {
        [removedPtyId]: true,
        [otherPtyId]: true
      },
      codexRestartNoticeByPtyId: {
        [removedPtyId]: { previousAccountLabel: 'Old', nextAccountLabel: 'New' },
        [otherPtyId]: { previousAccountLabel: 'Other old', nextAccountLabel: 'Other new' }
      },
      sshConnectionStates: new Map([
        [targetId, { targetId, status: 'disconnected', error: null, reconnectAttempt: 0 }],
        [
          otherTargetId,
          { targetId: otherTargetId, status: 'connected', error: null, reconnectAttempt: 0 }
        ]
      ]),
      sshTargetLabels: new Map([
        [targetId, 'Removed target'],
        [otherTargetId, 'Other target']
      ]),
      remoteWorkspaceHydratedTargetIds: new Set([targetId, otherTargetId]),
      remoteWorkspaceSyncStatusByTargetId: {
        [targetId]: { phase: 'offline' },
        [otherTargetId]: { phase: 'synced' }
      },
      portForwardsByConnection: {
        [targetId]: [
          {
            id: 'pf-1',
            connectionId: targetId,
            localPort: 3000,
            remoteHost: '127.0.0.1',
            remotePort: 3000
          }
        ],
        [otherTargetId]: [
          {
            id: 'pf-2',
            connectionId: otherTargetId,
            localPort: 4000,
            remoteHost: '127.0.0.1',
            remotePort: 4000
          }
        ]
      },
      detectedPortsByConnection: {
        [targetId]: [{ port: 3000, host: '127.0.0.1' }],
        [otherTargetId]: [{ port: 4000, host: '127.0.0.1' }]
      },
      sshCredentialQueue: [
        { requestId: 'req-1', targetId, kind: 'passphrase', detail: 'key' },
        { requestId: 'req-2', targetId: otherTargetId, kind: 'password', detail: 'password' }
      ],
      deferredSshReconnectTargets: [targetId, otherTargetId],
      deferredSshSessionIdsByTabId: {
        'tab-ssh': 'legacy-session-without-target-prefix',
        'tab-stale-encoded': toAppSshPtyId(targetId, 'pty-1'),
        'tab-other': toAppSshPtyId(otherTargetId, 'pty-2')
      }
    })

    store.getState().clearRemovedSshTargetState(targetId)

    const state = store.getState()
    expect(state.sshConnectionStates.has(targetId)).toBe(false)
    expect(state.sshTargetLabels.has(targetId)).toBe(false)
    expect(state.remoteWorkspaceHydratedTargetIds.has(targetId)).toBe(false)
    expect(state.remoteWorkspaceSyncStatusByTargetId[targetId]).toBeUndefined()
    expect(state.portForwardsByConnection[targetId]).toBeUndefined()
    expect(state.detectedPortsByConnection[targetId]).toBeUndefined()
    expect(state.sshCredentialQueue.map((req) => req.targetId)).toEqual([otherTargetId])
    expect(state.deferredSshReconnectTargets).toEqual([otherTargetId])
    expect(state.deferredSshSessionIdsByTabId).toEqual({
      'tab-other': toAppSshPtyId(otherTargetId, 'pty-2')
    })
    expect(state.tabsByWorktree[worktreeId][0]).toMatchObject({ id: 'tab-ssh', ptyId: null })
    expect('pendingActivationSpawn' in state.tabsByWorktree[worktreeId][0]).toBe(false)
    expect(state.ptyIdsByTabId['tab-ssh']).toEqual([])
    expect(state.lastKnownRelayPtyIdByTabId['tab-ssh']).toBeUndefined()
    expect(state.lastKnownRelayPtyIdByTabId['tab-stale-last-known']).toBeUndefined()
    expect(state.pendingCodexPaneRestartIds[removedPtyId]).toBeUndefined()
    expect(state.codexRestartNoticeByPtyId[removedPtyId]).toBeUndefined()

    expect(state.sshConnectionStates.get(otherTargetId)?.status).toBe('connected')
    expect(state.sshTargetLabels.get(otherTargetId)).toBe('Other target')
    expect(state.remoteWorkspaceHydratedTargetIds.has(otherTargetId)).toBe(true)
    expect(state.remoteWorkspaceSyncStatusByTargetId[otherTargetId]).toEqual({ phase: 'synced' })
    expect(state.portForwardsByConnection[otherTargetId]).toHaveLength(1)
    expect(state.detectedPortsByConnection[otherTargetId]).toHaveLength(1)
    expect(state.tabsByWorktree[otherWorktreeId][0]?.ptyId).toBe(otherPtyId)
    expect(state.ptyIdsByTabId['tab-other']).toEqual([otherPtyId])
    expect(state.lastKnownRelayPtyIdByTabId['tab-other']).toBe(otherPtyId)
    expect(state.pendingCodexPaneRestartIds[otherPtyId]).toBe(true)
    expect(state.codexRestartNoticeByPtyId[otherPtyId]).toEqual({
      previousAccountLabel: 'Other old',
      nextAccountLabel: 'Other new'
    })
  })

  it('keeps SSH target label references stable when refreshed metadata is unchanged', () => {
    const store = createTestStore()
    const labels = new Map([['ssh-1', 'Remote']])
    store.setState({ sshTargetLabels: labels })
    const previousState = store.getState()

    store.getState().setSshTargetsMetadata([{ id: 'ssh-1', label: 'Remote' }])

    expect(store.getState()).toBe(previousState)
    expect(store.getState().sshTargetLabels).toBe(labels)
  })

  it('keeps SSH connection state references stable when duplicate state arrives', () => {
    const store = createTestStore()
    const sshConnectionStates = new Map([
      [
        'ssh-1',
        { targetId: 'ssh-1', status: 'connected' as const, error: null, reconnectAttempt: 0 }
      ]
    ])
    store.setState({ sshConnectionStates, sshConnectedGeneration: 1 })
    const previousState = store.getState()

    store.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    expect(store.getState()).toBe(previousState)
    expect(store.getState().sshConnectionStates).toBe(sshConnectionStates)
    expect(store.getState().sshConnectedGeneration).toBe(1)
  })

  it('does not publish state when cleanup finds no removed SSH target state', () => {
    const store = createTestStore()
    const previousState = store.getState()

    store.getState().clearRemovedSshTargetState('missing-target')

    expect(store.getState()).toBe(previousState)
  })

  it('preserves untouched cleanup slice references while removing deferred target metadata', () => {
    const store = createTestStore()
    const sshConnectionStates = new Map([
      [
        'ssh-2',
        { targetId: 'ssh-2', status: 'connected' as const, error: null, reconnectAttempt: 0 }
      ]
    ])
    const sshTargetLabels = new Map([['ssh-2', 'Other']])
    const remoteWorkspaceHydratedTargetIds = new Set(['ssh-2'])
    const remoteWorkspaceSyncStatusByTargetId = { 'ssh-2': { phase: 'synced' as const } }
    const portForwardsByConnection = { 'ssh-2': [] }
    const detectedPortsByConnection = { 'ssh-2': [] }
    const sshCredentialQueue = [
      { requestId: 'req-2', targetId: 'ssh-2', kind: 'password' as const, detail: 'password' }
    ]
    const deferredSshSessionIdsByTabId = {
      'tab-other': toAppSshPtyId('ssh-2', 'pty-2')
    }
    store.setState({
      sshConnectionStates,
      sshTargetLabels,
      remoteWorkspaceHydratedTargetIds,
      remoteWorkspaceSyncStatusByTargetId,
      portForwardsByConnection,
      detectedPortsByConnection,
      sshCredentialQueue,
      deferredSshReconnectTargets: ['ssh-1'],
      deferredSshSessionIdsByTabId
    })

    store.getState().clearRemovedSshTargetState('ssh-1')

    const state = store.getState()
    expect(state.deferredSshReconnectTargets).toEqual([])
    expect(state.sshConnectionStates).toBe(sshConnectionStates)
    expect(state.sshTargetLabels).toBe(sshTargetLabels)
    expect(state.remoteWorkspaceHydratedTargetIds).toBe(remoteWorkspaceHydratedTargetIds)
    expect(state.remoteWorkspaceSyncStatusByTargetId).toBe(remoteWorkspaceSyncStatusByTargetId)
    expect(state.portForwardsByConnection).toBe(portForwardsByConnection)
    expect(state.detectedPortsByConnection).toBe(detectedPortsByConnection)
    expect(state.sshCredentialQueue).toBe(sshCredentialQueue)
    expect(state.deferredSshSessionIdsByTabId).toBe(deferredSshSessionIdsByTabId)
  })
})
