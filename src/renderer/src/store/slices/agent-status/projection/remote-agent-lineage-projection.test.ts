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
const worker = () => listed().find((row) => row.paneKey === WORKER)

beforeEach(() => {
  useAppStore.setState({
    runtimeAgentOrchestrationByPaneKey: {},
    remoteAgentOrchestrationByHost: {},
    unifiedTabsByWorktree: {},
    tabsByWorktree: {
      [WORKTREE]: [
        makeTab({ id: WORKER_TAB, worktreeId: WORKTREE, title: '✳ Claude Code' }),
        makeTab({ id: 'tab-coordinator', worktreeId: WORKTREE })
      ]
    },
    ptyIdsByTabId: {
      [WORKER_TAB]: [toRemoteRuntimePtyId('pty-1', ENVIRONMENT)],
      'tab-coordinator': [toRemoteRuntimePtyId('pty-2', ENVIRONMENT)]
    },
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
  expect(worker()?.entry.orchestration).toBeUndefined()
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
  expect(worker()?.entry.orchestration).toBeUndefined()
})

it('drops the remote row’s lineage when its host’s last context leaves', () => {
  const store = useAppStore.getState()
  store.setRuntimeAgentOrchestrationByPaneKey(
    { [WORKER]: { taskId: 'task-w', dispatchId: 'dispatch-w', parentPaneKey: COORDINATOR } },
    HOST
  )
  expect(worker()?.entry.orchestration?.parentPaneKey).toBe(COORDINATOR)
  store.setRuntimeAgentOrchestrationByPaneKey({}, HOST)
  expect(worker()?.entry.orchestration).toBeUndefined()
})

it('keeps a local terminal’s own lineage when a remote host reports the same pane key', () => {
  const LOCAL_TAB = 'tab-local'
  const LOCAL_WORKER = makePaneKey(LOCAL_TAB, LEAF)
  const LOCAL_COORDINATOR = makePaneKey('tab-local-coordinator', LEAF)
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE]: [makeTab({ id: LOCAL_TAB, worktreeId: WORKTREE, title: '✳ Claude Code' })]
    },
    ptyIdsByTabId: { [LOCAL_TAB]: ['pty-local'] },
    terminalLayoutsByTabId: {
      [LOCAL_TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null
      }
    }
  })
  const store = useAppStore.getState()
  store.setRuntimeAgentOrchestrationByPaneKey({
    [LOCAL_WORKER]: { taskId: 'task-l', dispatchId: 'dispatch-l', parentPaneKey: LOCAL_COORDINATOR }
  })
  store.setRuntimeAgentOrchestrationByPaneKey(
    { [LOCAL_WORKER]: { taskId: 'task-r', dispatchId: 'dispatch-r', parentPaneKey: COORDINATOR } },
    HOST
  )
  const row = listed().find((candidate) => candidate.paneKey === LOCAL_WORKER)
  expect(row?.entry.orchestration?.dispatchId).toBe('dispatch-l')
  expect(row?.entry.orchestration?.parentPaneKey).toBe(LOCAL_COORDINATOR)
})

it('drops a remote worker’s parent link when that parent is a local row, however its key is spelled', () => {
  const LOCAL_PARENT_TAB = 'tab-local-parent'
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE]: [
        makeTab({ id: WORKER_TAB, worktreeId: WORKTREE, title: '✳ Claude Code' }),
        makeTab({ id: LOCAL_PARENT_TAB, worktreeId: WORKTREE })
      ]
    },
    ptyIdsByTabId: {
      [WORKER_TAB]: [toRemoteRuntimePtyId('pty-1', ENVIRONMENT)],
      [LOCAL_PARENT_TAB]: ['pty-local']
    }
  })
  useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(
    {
      [WORKER]: {
        taskId: 'task-w',
        dispatchId: 'dispatch-w',
        parentPaneKey: makePaneKey(LOCAL_PARENT_TAB, LEAF)
      }
    },
    HOST
  )
  expect(worker()?.entry.orchestration?.dispatchId).toBe('dispatch-w')
  expect(worker()?.entry.orchestration?.parentPaneKey).toBeUndefined()
})
