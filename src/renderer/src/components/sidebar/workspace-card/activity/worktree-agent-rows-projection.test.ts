import { expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createWorktreeAgentRowsSelector } from './worktree-agent-rows-projection'

function setup(ptyId: string | null = null) {
  const store = createTestStore()
  const tab = makeTab({ id: 'tab', worktreeId: 'workspace', ptyId })
  const entry = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    worktreeId: 'workspace',
    agentType: 'claude' as const,
    state: 'done' as const,
    prompt: 'Completed task',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
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
    agentStatusByPaneKey: { 'tab:11111111-1111-4111-8111-111111111111': entry },
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

it.each([null, 'hostless-pty'])(
  'keeps remote completion ownership after terminal removal (%s)',
  (ptyId) => {
    const { store, tab, entry } = setup(ptyId)
    store.setState({ unifiedTabsByWorktree: {} })
    store.getState().retainAgents([
      {
        entry,
        tab,
        worktreeId: 'workspace',
        agentType: 'claude',
        startedAt: entry.stateStartedAt
      }
    ])
    store.setState({ tabsByWorktree: {}, agentStatusByPaneKey: {}, worktreesByRepo: {} })
    expect(
      createWorktreeAgentRowsSelector(
        'workspace',
        'ssh:remote'
      )(store.getState()).map((row) => row.paneKey)
    ).toEqual(['tab:11111111-1111-4111-8111-111111111111'])
    expect(createWorktreeAgentRowsSelector('workspace', 'local')(store.getState())).toEqual([])
  }
)

it('does not infer remote ownership without workspace attribution', () => {
  const { store, tab, entry } = setup()
  store.setState({ unifiedTabsByWorktree: {}, worktreesByRepo: {} })
  store
    .getState()
    .retainAgents([
      { entry, tab, worktreeId: 'workspace', agentType: 'claude', startedAt: entry.stateStartedAt }
    ])
  store.setState({ tabsByWorktree: {}, agentStatusByPaneKey: {} })
  expect(createWorktreeAgentRowsSelector('workspace', 'ssh:remote')(store.getState())).toEqual([])
})
