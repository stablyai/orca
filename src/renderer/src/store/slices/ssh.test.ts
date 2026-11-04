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
      pendingPaneAccountRestarts: {
        [removedPtyId]: 'codex',
        [otherPtyId]: 'codex'
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
      transientClearedAgentStatusConnectionIds: {
        [targetId]: true,
        [otherTargetId]: true
      },
      deferredSshSessionIdsByTabId: {
        'tab-ssh': 'legacy-session-without-target-prefix',
        'tab-stale-encoded': toAppSshPtyId(targetId, 'pty-1'),
        'tab-other': toAppSshPtyId(otherTargetId, 'pty-2')
      },
      // Pending reconnect counts as orphan-sweep liveness; removal must clear it or pin the dead tab (#9911).
      pendingReconnectPtyIdByTabId: {
        'tab-ssh': toAppSshPtyId(targetId, 'pty-1'),
        'tab-stale-encoded': toAppSshPtyId(targetId, 'pty-9'),
        'tab-other': toAppSshPtyId(otherTargetId, 'pty-2')
      }
    })

    store.getState().clearRemovedSshTargetState(targetId)

    const state = store.getState()
    expect(state.sshConnectionStates.has(targetId)).toBe(false)
    expect(state.sshTargetLabels.has(targetId)).toBe(false)
    expect(state.portForwardsByConnection[targetId]).toBeUndefined()
    expect(state.detectedPortsByConnection[targetId]).toBeUndefined()
    expect(state.sshCredentialQueue.map((req) => req.targetId)).toEqual([otherTargetId])
    expect(state.deferredSshReconnectTargets).toEqual([otherTargetId])
    expect(state.transientClearedAgentStatusConnectionIds).toEqual({
      [otherTargetId]: true
    })
    expect(state.deferredSshSessionIdsByTabId).toEqual({
      'tab-other': toAppSshPtyId(otherTargetId, 'pty-2')
    })
    expect(state.pendingReconnectPtyIdByTabId).toEqual({
      'tab-other': toAppSshPtyId(otherTargetId, 'pty-2')
    })
    expect(state.tabsByWorktree[worktreeId][0]).toMatchObject({ id: 'tab-ssh', ptyId: null })
    expect('pendingActivationSpawn' in state.tabsByWorktree[worktreeId][0]).toBe(false)
    expect(state.ptyIdsByTabId['tab-ssh']).toEqual([])
    expect(state.lastKnownRelayPtyIdByTabId['tab-ssh']).toBeUndefined()
    expect(state.lastKnownRelayPtyIdByTabId['tab-stale-last-known']).toBeUndefined()
    expect(state.pendingPaneAccountRestarts[removedPtyId]).toBeUndefined()
    expect(state.codexRestartNoticeByPtyId[removedPtyId]).toBeUndefined()

    expect(state.sshConnectionStates.get(otherTargetId)?.status).toBe('connected')
    expect(state.sshTargetLabels.get(otherTargetId)).toBe('Other target')
    expect(state.portForwardsByConnection[otherTargetId]).toHaveLength(1)
    expect(state.detectedPortsByConnection[otherTargetId]).toHaveLength(1)
    expect(state.tabsByWorktree[otherWorktreeId][0]?.ptyId).toBe(otherPtyId)
    expect(state.ptyIdsByTabId['tab-other']).toEqual([otherPtyId])
    expect(state.lastKnownRelayPtyIdByTabId['tab-other']).toBe(otherPtyId)
    expect(state.pendingPaneAccountRestarts[otherPtyId]).toBe('codex')
    expect(state.codexRestartNoticeByPtyId[otherPtyId]).toEqual({
      previousAccountLabel: 'Other old',
      nextAccountLabel: 'Other new'
    })
  })

  it("preserves another SSH target's terminal bindings when repo ids collide", () => {
    const store = createTestStore()
    const removedTargetId = 'target-a'
    const survivingTargetId = 'target-b'
    const removedWorktreeId = 'shared::/srv/a/work'
    const survivingWorktreeId = 'shared::/srv/b/work'
    const removedPtyId = toAppSshPtyId(removedTargetId, 'pty-a')
    const survivingPtyId = toAppSshPtyId(survivingTargetId, 'pty-b')

    store.setState({
      repos: [
        {
          ...TEST_REPO,
          id: 'shared',
          connectionId: removedTargetId,
          executionHostId: 'ssh:target-a'
        },
        {
          ...TEST_REPO,
          id: 'shared',
          connectionId: survivingTargetId,
          executionHostId: 'ssh:target-b'
        }
      ],
      worktreesByRepo: {
        shared: [
          makeWorktree({
            id: removedWorktreeId,
            repoId: 'shared',
            hostId: 'ssh:target-a'
          }),
          makeWorktree({
            id: survivingWorktreeId,
            repoId: 'shared',
            hostId: 'ssh:target-b'
          })
        ]
      },
      tabsByWorktree: {
        [removedWorktreeId]: [
          makeTab({ id: 'tab-a', worktreeId: removedWorktreeId, ptyId: removedPtyId })
        ],
        [survivingWorktreeId]: [
          makeTab({ id: 'tab-b', worktreeId: survivingWorktreeId, ptyId: survivingPtyId })
        ]
      },
      ptyIdsByTabId: { 'tab-a': [removedPtyId], 'tab-b': [survivingPtyId] },
      lastKnownRelayPtyIdByTabId: { 'tab-a': removedPtyId, 'tab-b': survivingPtyId }
    })

    store.getState().clearRemovedSshTargetState(removedTargetId)

    const state = store.getState()
    expect(state.tabsByWorktree[removedWorktreeId][0]?.ptyId).toBeNull()
    expect(state.tabsByWorktree[survivingWorktreeId][0]?.ptyId).toBe(survivingPtyId)
    expect(state.ptyIdsByTabId['tab-b']).toEqual([survivingPtyId])
    expect(state.lastKnownRelayPtyIdByTabId['tab-b']).toBe(survivingPtyId)
  })
})
