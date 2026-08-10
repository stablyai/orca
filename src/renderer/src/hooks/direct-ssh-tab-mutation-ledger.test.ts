import { describe, expect, it } from 'vitest'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { TerminalTab } from '../../../shared/types'
import type { AppState } from '../store/types'
import { createDirectSshTabMutationLedger } from './direct-ssh-tab-mutation-ledger'

const WT_A = 'repo-a::/remote/a'
const WT_B = 'repo-b::/remote/b'

function tab(id: string, worktreeId: string): TerminalTab {
  return { id, worktreeId, ptyId: `pty-${id}` } as TerminalTab
}

function state(tabsByWorktree: AppState['tabsByWorktree']): AppState {
  return {
    repos: [
      { id: 'repo-a', path: '/remote/a', connectionId: 'target-a' },
      { id: 'repo-b', path: '/remote/b', connectionId: 'target-b' }
    ],
    worktreesByRepo: {
      'repo-a': [{ id: WT_A, repoId: 'repo-a', hostId: 'ssh:target-a' }],
      'repo-b': [{ id: WT_B, repoId: 'repo-b', hostId: 'ssh:target-b' }]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    sshTargetLabels: new Map([
      ['target-a', 'A'],
      ['target-b', 'B']
    ]),
    sshConnectionStates: new Map(),
    remoteWorkspaceHydratedTargetIds: new Set(['target-a', 'target-b']),
    tabsByWorktree
  } as unknown as AppState
}

function snapshot(
  targetId: string,
  worktreePath: string,
  tabIds: readonly string[]
): RemoteWorkspaceSnapshot {
  return {
    namespace: targetId,
    revision: 2,
    updatedAt: 2,
    schemaVersion: 1,
    session: {
      activeWorktreePath: worktreePath,
      activeTabId: tabIds[0] ?? null,
      tabsByWorktreePath: {
        [worktreePath]: tabIds.map((id) => ({
          id,
          worktreePath,
          ptyId: `pty-${id}`,
          title: id,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }))
      },
      terminalLayoutsByTabId: {}
    }
  }
}

describe('createDirectSshTabMutationLedger', () => {
  it('records additions and deletions only for their exact target', () => {
    const ledger = createDirectSshTabMutationLedger()
    ledger.observeState(state({ [WT_A]: [tab('a-old', WT_A)], [WT_B]: [tab('b-old', WT_B)] }))

    ledger.observeState(state({ [WT_A]: [tab('a-old', WT_A), tab('a-new', WT_A)], [WT_B]: [] }))

    expect([...ledger.pendingTabPresence('target-a')]).toEqual([['a-new', 'present']])
    expect([...ledger.pendingTabPresence('target-b')]).toEqual([['b-old', 'absent']])
  })

  it('clears only mutations acknowledged by a target snapshot', () => {
    const ledger = createDirectSshTabMutationLedger()
    ledger.observeState(state({ [WT_A]: [tab('a-old', WT_A)], [WT_B]: [tab('b-old', WT_B)] }))
    ledger.observeState(state({ [WT_A]: [tab('a-new', WT_A)], [WT_B]: [] }))

    ledger.acknowledgeSnapshot('target-a', snapshot('target-a', '/remote/a', ['a-old', 'a-new']))

    expect([...ledger.pendingTabPresence('target-a')]).toEqual([['a-old', 'absent']])
    expect([...ledger.pendingTabPresence('target-b')]).toEqual([['b-old', 'absent']])
  })

  it('does not turn target-scoped snapshot hydration into local mutations', () => {
    const ledger = createDirectSshTabMutationLedger()
    ledger.observeState(state({ [WT_A]: [tab('a-old', WT_A)], [WT_B]: [tab('b-old', WT_B)] }))

    const finish = ledger.beginSnapshotApply('target-a')
    ledger.observeState(state({ [WT_A]: [tab('a-remote', WT_A)], [WT_B]: [tab('b-old', WT_B)] }))
    finish()

    expect([...ledger.pendingTabPresence('target-a')]).toEqual([])
    expect([...ledger.pendingTabPresence('target-b')]).toEqual([])
  })

  it('fails closed at the per-target mutation bound until a full snapshot acknowledges local state', () => {
    const ledger = createDirectSshTabMutationLedger()
    const initialTabs = Array.from({ length: 2_049 }, (_, index) => tab(`tab-${index}`, WT_A))
    ledger.observeState(state({ [WT_A]: initialTabs, [WT_B]: [] }))

    ledger.observeState(state({ [WT_A]: [], [WT_B]: [] }))

    expect(ledger.pendingTabPresence('target-a').size).toBe(0)
    expect(ledger.canApplySnapshot?.('target-a')).toBe(false)
    ledger.acknowledgeSnapshot('target-a', snapshot('target-a', '/remote/a', []))
    expect(ledger.canApplySnapshot?.('target-a')).toBe(true)
  })

  it('drops target state when configuration removal owns cleanup', () => {
    const ledger = createDirectSshTabMutationLedger()
    const initial = state({ [WT_A]: [tab('a-old', WT_A)], [WT_B]: [] })
    ledger.observeState(initial)
    ledger.observeState(state({ [WT_A]: [], [WT_B]: [] }))

    ledger.observeState({
      ...initial,
      repos: initial.repos.filter((repo) => repo.connectionId !== 'target-a'),
      worktreesByRepo: { 'repo-b': initial.worktreesByRepo['repo-b'] },
      sshTargetLabels: new Map([['target-b', 'B']]),
      remoteWorkspaceHydratedTargetIds: new Set(['target-b'])
    })

    expect(ledger.pendingTabPresence('target-a').size).toBe(0)
  })
})
