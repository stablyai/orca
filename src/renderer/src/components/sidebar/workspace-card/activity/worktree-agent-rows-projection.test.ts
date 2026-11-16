import { expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { createWorktreeAgentRowsSelector } from './worktree-agent-rows-projection'

const TIMESTAMP = 1_000

function setup(ptyId: string | null = null) {
  const store = createTestStore()
  const tab = makeTab({ id: 'tab', worktreeId: 'workspace', ptyId })
  const entry = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    worktreeId: 'workspace',
    agentType: 'claude' as const,
    state: 'done' as const,
    prompt: 'Completed task',
    updatedAt: TIMESTAMP,
    stateStartedAt: TIMESTAMP,
    stateHistory: []
  }
  store.setState({
    tabsByWorktree: { workspace: [tab] },
    unifiedTabsByWorktree: {
      workspace: [
        makeUnifiedTab({
          id: 'tab',
          worktreeId: 'workspace',
          groupId: 'group',
          executionHostId: 'ssh:remote'
        })
      ]
    },
    agentStatusByPaneKey: acceptedAgentStatuses([
      ['tab:11111111-1111-4111-8111-111111111111', entry]
    ]),
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'workspace', repoId: 'repo', hostId: 'ssh:remote' })]
    }
  })
  return { store, tab, entry }
}

it('attributes PTY-less live rows to their terminal stamp and reacts to stamp changes', () => {
  const { store } = setup()
  const remote = createWorktreeAgentRowsSelector('workspace', 'ssh:remote')
  const local = createWorktreeAgentRowsSelector('workspace', 'local')
  expect(remote(store.getState()).map((row) => row.paneKey)).toEqual([
    'tab:11111111-1111-4111-8111-111111111111'
  ])
  expect(local(store.getState())).toEqual([])
  store.setState({
    unifiedTabsByWorktree: {
      workspace: [
        makeUnifiedTab({
          id: 'tab',
          worktreeId: 'workspace',
          groupId: 'group',
          executionHostId: 'local'
        })
      ]
    }
  })
  expect(remote(store.getState())).toEqual([])
  expect(local(store.getState()).map((row) => row.paneKey)).toEqual([
    'tab:11111111-1111-4111-8111-111111111111'
  ])
})

it('updates pre-hydration row ownership when global PTY and layout bindings arrive', () => {
  const { store, entry } = setup()
  // Rows come from the store's keyed projection, so the pre-hydration state is written through it.
  store.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: acceptedAgentStatuses([
      ['tab:11111111-1111-4111-8111-111111111111', { ...entry, state: 'working' as const }]
    ])
  })
  const state = store.getState()
  const remote = createWorktreeAgentRowsSelector('workspace', 'ssh:remote')
  const local = createWorktreeAgentRowsSelector('workspace', 'local')
  expect(remote(state)).toEqual([])
  expect(local(state).map((row) => row.paneKey)).toEqual([
    'tab:11111111-1111-4111-8111-111111111111'
  ])

  const withPty = { ...state, ptyIdsByTabId: { tab: ['ssh:remote@@pty'] } }
  expect(remote(withPty).map((row) => row.paneKey)).toEqual([
    'tab:11111111-1111-4111-8111-111111111111'
  ])
  expect(local(withPty)).toEqual([])

  const withLayout = {
    ...withPty,
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf' as const, leafId: '11111111-1111-4111-8111-111111111111' },
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'local-pty' }
      }
    }
  }
  expect(remote(withLayout)).toEqual([])
  expect(local(withLayout).map((row) => row.paneKey)).toEqual([
    'tab:11111111-1111-4111-8111-111111111111'
  ])
})
