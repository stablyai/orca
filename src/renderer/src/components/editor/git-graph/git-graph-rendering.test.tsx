import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { disposeGitGraphHistory } from './git-graph-tab-controllers'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitGraphTab } from './git-graph-tab'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'

const { getHistory, getRefs } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getRefs: vi.fn()
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitHistory: getHistory,
  getRuntimeGitRefs: getRefs
}))
vi.mock('@/runtime/source-control/git/runtime-git-diff-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitCommitCompare: vi.fn(async () => ({ summary: { status: 'ready' }, entries: [] }))
}))
const container = document.createElement('div')
document.body.appendChild(container)
let root = createRoot(container)
const initialState = useAppStore.getState()
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 20 * 24)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  )
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { r: [local] },
    activeWorktreeId: workspaceId,
    activeWorkspaceExecutionHostId: 'local',
    gitGraphFiltersByWorktree: {}
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  disposeGitGraphHistory(`${workspaceId}::git-graph`)
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})
const result: GitHistoryResult = {
  items: [{ id: 'a', subject: 'subject', message: 'subject', parentIds: [] }],
  hasMore: false,
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  limit: 50
}

const renderTab = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )

it('shows agent sessions on the branch of the workspace showing the graph', async () => {
  const tabId = 'tab-1'
  const paneKey = `${tabId}:11111111-1111-4111-8111-111111111111`
  useAppStore.setState({
    tabsByWorktree: {
      [workspaceId]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId: workspaceId,
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        worktreeId: workspaceId,
        tabId,
        agentType: 'claude',
        state: 'working',
        prompt: 'Ship it',
        updatedAt: 0,
        stateStartedAt: 0,
        stateHistory: []
      }
    }
  })
  getHistory.mockReset().mockResolvedValue({
    ...result,
    currentRef: { id: local.branch, name: 'main' },
    items: [{ ...result.items[0], references: [{ id: local.branch, name: 'main' }] }]
  })
  await renderTab()
  expect(container.querySelector('[aria-label^="Agents in this workspace"]')).not.toBeNull()
})
