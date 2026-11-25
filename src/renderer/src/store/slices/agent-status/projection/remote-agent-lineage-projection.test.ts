import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

// The sidebar's own path: projection.list over a WSL terminal whose only status is its title.
const ENVIRONMENT = 'wsl-ubuntu'
const HOST = toRuntimeExecutionHostId(ENVIRONMENT)
const WORKTREE = 'wt-wsl'
const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKER_TAB = 'tab-worker'
const WORKER = makePaneKey(WORKER_TAB, LEAF)
const COORDINATOR = makePaneKey('tab-coordinator', LEAF)

const listed = () => useAppStore.getState().agentStatusByPaneKey.projection.list(WORKTREE)

beforeEach(() => {
  useAppStore.setState({
    runtimeAgentOrchestrationByPaneKey: {},
    remoteAgentOrchestrationByHost: {},
    unifiedTabsByWorktree: {},
    tabsByWorktree: {
      [WORKTREE]: [makeTab({ id: WORKER_TAB, worktreeId: WORKTREE, title: '✳ Claude Code' })]
    },
    ptyIdsByTabId: { [WORKER_TAB]: [toRemoteRuntimePtyId('pty-1', ENVIRONMENT)] },
    terminalLayoutsByTabId: {
      [WORKER_TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null
      }
    }
  })
})

it('nests a title-only terminal worker on a remote host by that host’s lineage', () => {
  expect(listed().map((row) => row.paneKey)).toEqual([WORKER])
  expect(listed()[0]?.entry.orchestration).toBeUndefined()
  useAppStore
    .getState()
    .setRuntimeAgentOrchestrationByPaneKey(
      { [WORKER]: { taskId: 'task-w', dispatchId: 'dispatch-w', parentPaneKey: COORDINATOR } },
      HOST
    )
  // This computer's graph reply carries none of the host's Dispatches.
  useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({})
  expect(listed().find((row) => row.paneKey === WORKER)?.entry.orchestration?.parentPaneKey).toBe(
    COORDINATOR
  )
})

it('ignores another host’s context for a pane this window runs elsewhere', () => {
  useAppStore
    .getState()
    .setRuntimeAgentOrchestrationByPaneKey(
      { [WORKER]: { taskId: 'task-x', dispatchId: 'dispatch-x', parentPaneKey: COORDINATOR } },
      toRuntimeExecutionHostId('other-host')
    )
  expect(listed().map((row) => row.paneKey)).toEqual([WORKER])
  expect(listed()[0]?.entry.orchestration).toBeUndefined()
})
