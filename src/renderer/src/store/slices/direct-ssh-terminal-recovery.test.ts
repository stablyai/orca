import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  clearDirectSshTerminalBindings,
  type DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery'
import { createTestStore, makeWorktree } from './store-test-helpers'

function makeTab(id: string, ptyId: string | null, pendingActivationSpawn?: true): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'repo::/work',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(pendingActivationSpawn ? { pendingActivationSpawn } : {})
  }
}

function makeState(): DirectSshTerminalBindingState {
  return {
    tabsByWorktree: {
      'repo::/ssh-work': [
        makeTab('ssh-live', 'ssh-target@@pty-1', true),
        makeTab('ssh-unbound', null, true)
      ],
      'folder::ssh-work': [makeTab('folder-live', 'ssh-target@@pty-2')],
      'repo::/other-host': [makeTab('other-live', 'ssh-other@@pty-3', true)]
    },
    ptyIdsByTabId: {
      'ssh-live': ['ssh-target@@pty-1', 'ssh-target@@pty-split'],
      'ssh-unbound': [],
      'folder-live': ['ssh-target@@pty-2'],
      'other-live': ['ssh-other@@pty-3']
    },
    lastKnownRelayPtyIdByTabId: {
      'ssh-live': 'ssh-target@@pty-1',
      'folder-live': 'ssh-target@@pty-2',
      'other-live': 'ssh-other@@pty-3'
    },
    pendingCodexPaneRestartIds: {
      'ssh-target@@pty-1': true,
      'ssh-target@@pty-split': true,
      'ssh-other@@pty-3': true
    },
    codexRestartNoticeByPtyId: {
      'ssh-target@@pty-1': {
        previousAccountLabel: 'old',
        nextAccountLabel: 'new'
      },
      'ssh-other@@pty-3': {
        previousAccountLabel: 'old',
        nextAccountLabel: 'new'
      }
    },
    directSshPaneRetryByTabId: {},
    directSshLivePtyBindingByTabId: {},
    directSshPaneRetryHistoryByTabId: {}
  }
}

describe('clearDirectSshTerminalBindings', () => {
  it('clears exact Git and folder workspace bindings in one projection', () => {
    const state = makeState()
    const result = clearDirectSshTerminalBindings(
      state,
      new Set(['repo::/ssh-work', 'folder::ssh-work'])
    )

    expect(result.clearedCount).toBe(2)
    expect(result.patch?.tabsByWorktree?.['repo::/ssh-work']).toEqual([
      expect.objectContaining({ id: 'ssh-live', ptyId: null }),
      state.tabsByWorktree['repo::/ssh-work'][1]
    ])
    expect(result.patch?.tabsByWorktree?.['repo::/ssh-work'][0]).not.toHaveProperty(
      'pendingActivationSpawn'
    )
    expect(result.patch?.tabsByWorktree?.['repo::/ssh-work'][1]).toBe(
      state.tabsByWorktree['repo::/ssh-work'][1]
    )
    expect(result.patch?.tabsByWorktree?.['folder::ssh-work'][0].ptyId).toBeNull()
    expect(result.patch?.ptyIdsByTabId).toMatchObject({
      'ssh-live': [],
      'folder-live': [],
      'other-live': ['ssh-other@@pty-3']
    })
  })

  it('preserves relay reattach ids and every other host', () => {
    const state = makeState()
    const result = clearDirectSshTerminalBindings(state, new Set(['repo::/ssh-work']))

    expect(result.patch).not.toHaveProperty('lastKnownRelayPtyIdByTabId')
    expect(state.lastKnownRelayPtyIdByTabId['ssh-live']).toBe('ssh-target@@pty-1')
    expect(result.patch?.tabsByWorktree?.['repo::/other-host']).toBe(
      state.tabsByWorktree['repo::/other-host']
    )
    expect(result.patch?.pendingCodexPaneRestartIds).toEqual({
      'ssh-other@@pty-3': true
    })
    expect(result.patch?.codexRestartNoticeByPtyId).toEqual({
      'ssh-other@@pty-3': {
        previousAccountLabel: 'old',
        nextAccountLabel: 'new'
      }
    })
  })

  it('re-arms reconnectable disconnects without erasing retry history', () => {
    const state = makeState()
    const authority = {
      targetId: 'target',
      providerEpoch: 'epoch-1',
      connectionGeneration: 1
    }
    state.directSshPaneRetryByTabId['ssh-live'] = {
      attemptId: 'attempt-1',
      authority,
      tabGeneration: 1,
      startedAt: 10
    } as never
    state.directSshLivePtyBindingByTabId['folder-live'] = {
      authority,
      tabGeneration: 0,
      ptyId: 'ssh-target@@pty-2'
    } as never
    state.directSshPaneRetryHistoryByTabId['ssh-live'] = {
      authority,
      attemptedAt: [10]
    } as never

    const result = clearDirectSshTerminalBindings(
      state,
      new Set(['repo::/ssh-work', 'folder::ssh-work'])
    )

    expect(result.patch?.directSshPaneRetryByTabId).toEqual({})
    expect(result.patch?.directSshLivePtyBindingByTabId).toEqual({})
    expect(result.patch).not.toHaveProperty('directSshPaneRetryHistoryByTabId')
    expect(state.directSshPaneRetryHistoryByTabId['ssh-live']?.attemptedAt).toEqual([10])
  })

  it('clears an exact target through one Zustand publication without activity changes', () => {
    const store = createTestStore()
    const worktreeId = 'repo-ssh::/work/demo'
    const tab = { ...makeTab('ssh-live', 'ssh-target@@pty-1', true), worktreeId }
    store.setState({
      repos: [
        {
          id: 'repo-ssh',
          path: '/work/demo',
          displayName: 'demo',
          badgeColor: '#000',
          addedAt: 1,
          connectionId: 'target'
        }
      ],
      worktreesByRepo: {
        'repo-ssh': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-ssh',
            path: '/work/demo',
            hostId: 'ssh:target'
          })
        ]
      },
      tabsByWorktree: { [worktreeId]: [tab] },
      ptyIdsByTabId: { [tab.id]: ['ssh-target@@pty-1'] },
      lastKnownRelayPtyIdByTabId: { [tab.id]: 'ssh-target@@pty-1' },
      sortEpoch: 9
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    expect(store.getState().clearDirectSshTargetPtyBindings('target')).toBe(1)
    unsubscribe()

    const state = store.getState()
    expect(publications).toBe(1)
    expect(state.tabsByWorktree[worktreeId][0]).toMatchObject({ ptyId: null })
    expect(state.ptyIdsByTabId[tab.id]).toEqual([])
    expect(state.lastKnownRelayPtyIdByTabId[tab.id]).toBe('ssh-target@@pty-1')
    expect(state.sortEpoch).toBe(9)
  })

  it('leaves unbound tabs byte-identical and repeats as a no-op', () => {
    const state = makeState()
    const first = clearDirectSshTerminalBindings(state, new Set(['repo::/ssh-work']))
    const afterFirst = { ...state, ...first.patch }
    const second = clearDirectSshTerminalBindings(afterFirst, new Set(['repo::/ssh-work']))

    expect(first.patch?.tabsByWorktree?.['repo::/ssh-work'][1]).toBe(
      state.tabsByWorktree['repo::/ssh-work'][1]
    )
    expect(second).toEqual({ clearedCount: 0, patch: null })
  })
})
