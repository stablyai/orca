import { expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { selectLiveAgentStatusEntriesForWorktree } from './worktree-agent-row-selectors'

it.each(['working', 'blocked', 'waiting', 'done'] as const)(
  'keeps hydrated colliding host tabs in their own workspaces while %s',
  (state) => {
    const tabId = 'web-terminal-same-host-tab'
    const firstKey = makePaneKey(tabId, '11111111-1111-4111-8111-111111111111')
    const secondKey = makePaneKey(tabId, '22222222-2222-4222-8222-222222222222')
    const first = {
      paneKey: firstKey,
      state,
      updatedAt: 1000,
      prompt: '',
      stateStartedAt: 1000,
      stateHistory: [],
      agentType: 'omp' as const,
      worktreeId: 'folder:first',
      connectionId: 'host-a'
    }
    const second = {
      ...first,
      paneKey: secondKey,
      worktreeId: 'folder:second',
      connectionId: 'host-b'
    }
    const tab = {
      id: tabId,
      worktreeId: first.worktreeId,
      ptyId: null,
      title: 'OMP',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const input = {
      agentStatusByPaneKey: { [firstKey]: first, [secondKey]: second },
      retainedAgentsByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      tabsByWorktree: {
        [first.worktreeId]: [tab],
        [second.worktreeId]: [{ ...tab, worktreeId: second.worktreeId }]
      }
    }
    expect(selectLiveAgentStatusEntriesForWorktree(input, first.worktreeId)).toEqual([first])
    expect(selectLiveAgentStatusEntriesForWorktree(input, second.worktreeId)).toEqual([second])
    const ping = { ...first, prompt: 'next update' }
    const next = {
      ...input,
      agentStatusByPaneKey: { ...input.agentStatusByPaneKey, [firstKey]: ping }
    }
    expect(selectLiveAgentStatusEntriesForWorktree(next, first.worktreeId)).toEqual([ping])
    expect(selectLiveAgentStatusEntriesForWorktree(next, second.worktreeId)).toEqual([second])
  }
)
