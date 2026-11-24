import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getAgentRowMenuActions, resolveAgentRowMenuTarget } from './agent-row-menu-target'

const worktree = makeWorktree({ id: `${TEST_REPO.id}::/sample`, repoId: TEST_REPO.id })
const pairedHost: ExecutionHostId = 'runtime:env-1'

function chatTab(id: string, executionHostId: ExecutionHostId): Tab {
  return {
    id,
    entityId: `${id === 'local-chat' ? '1' : '2'}1111111-1111-4111-8111-111111111111`,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    worktreeId: worktree.id,
    groupId: 'group',
    executionHostId,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function seed(twin: boolean, active: boolean): AppState {
  const tabs = [chatTab('local-chat', 'local'), chatTab('paired-chat', pairedHost)]
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: twin
        ? [
            { ...worktree, hostId: 'local' },
            { ...worktree, hostId: pairedHost, runtimeOwnerEnvironmentId: 'env-1' }
          ]
        : [{ ...worktree, hostId: 'local' }]
    },
    unifiedTabsByWorktree: { [worktree.id]: tabs },
    ...(active ? { activeWorktreeId: worktree.id, activeWorkspaceExecutionHostId: 'local' } : {})
  })
  return useAppStore.getState()
}

function forkOffered(state: AppState, tabId: string, cardHostId: ExecutionHostId): boolean {
  const tab = state.unifiedTabsByWorktree[worktree.id]!.find((item) => item.id === tabId)!
  const target = resolveAgentRowMenuTarget(state, {
    worktreeId: worktree.id,
    cardHostId,
    paneKey: structuredAgentSessionPaneKey(tab.id, tab.entityId),
    tabId: tab.id
  })
  return target !== null && getAgentRowMenuActions(state, target, false).fork
}

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('offers row Fork for a local chat only when no other host has the workspace', () => {
  expect(forkOffered(seed(false, false), 'local-chat', 'local')).toBe(true)
  for (const active of [false, true]) {
    const twin = seed(true, active)
    expect(forkOffered(twin, 'local-chat', 'local')).toBe(false)
    expect(forkOffered(twin, 'paired-chat', pairedHost)).toBe(false)
  }
})
