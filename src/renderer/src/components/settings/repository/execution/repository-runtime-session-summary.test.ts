import { expect, it } from 'vitest'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { getProjectRuntimeSessionSummary } from './repository-runtime-session-summary'

it('recomputes when a tab slice is replaced', () => {
  const worktreeId = 'repo-0::/tmp/worktree'
  const state = {
    tabsByWorktree: {
      [worktreeId]: [
        makeTab({ id: 'tab-a', ptyId: 'pty-a', worktreeId }),
        makeTab({ id: 'tab-b', ptyId: 'pty-b', worktreeId })
      ]
    },
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {}
  }
  const first = getProjectRuntimeSessionSummary(state, 'repo-0')
  const next = getProjectRuntimeSessionSummary(
    {
      ...state,
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-new', ptyId: 'pty-new', worktreeId })]
      }
    },
    'repo-0'
  )

  expect(first.liveTerminalCount).toBe(2)
  expect(next.liveTerminalCount).toBe(1)
})
