import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'
import { prepareWorkerStopLanding } from './worker-stop-landing'

const worker = makeUnifiedTab({
  id: 'worker',
  worktreeId: 'wt',
  groupId: 'group',
  workerTab: {
    origin: {
      runId: 'run',
      taskId: 'task',
      dispatchId: 'dispatch',
      parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
      coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
    }
  }
})
beforeEach(() => {
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'wt',
    activeWorkspaceExecutionHostId: 'local',
    unifiedTabsByWorktree: { wt: [worker] },
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    openFiles: [],
    groupsByWorktree: {
      wt: [
        makeTabGroup({ id: 'group', worktreeId: 'wt', activeTabId: 'worker', tabOrder: ['worker'] })
      ]
    },
    splitLandingGroupIds: {}
  })
})

it('lands on welcome when a confirmed stop already removed the last surface', () => {
  const stopped = prepareWorkerStopLanding('wt', 'worker')
  useAppStore.setState({ unifiedTabsByWorktree: { wt: [] } })
  stopped(true)
  expect(useAppStore.getState().activeWorktreeId).toBeNull()
})
it('lands on welcome when the stop removal arrives in a later host frame', () => {
  prepareWorkerStopLanding('wt', 'worker')(true)
  useAppStore.setState({ unifiedTabsByWorktree: { wt: [] } })
  expect(useAppStore.getState().activeWorktreeId).toBeNull()
})
it('keeps a workspace selected when another pane still has a tab', () => {
  prepareWorkerStopLanding('wt', 'worker')(true)
  useAppStore.setState({
    unifiedTabsByWorktree: {
      wt: [makeUnifiedTab({ id: 'user', worktreeId: 'wt', groupId: 'other' })]
    }
  })
  expect(useAppStore.getState().activeWorktreeId).toBe('wt')
})
it('leaves a newly selected workspace alone when the stopped worker frame arrives', () => {
  prepareWorkerStopLanding('wt', 'worker')(true)
  useAppStore.setState({ activeWorktreeId: 'other' })
  useAppStore.setState({ unifiedTabsByWorktree: { wt: [] } })
  expect(useAppStore.getState().activeWorktreeId).toBe('other')
})
it('does not wait for a new removal after an already-settled receipt', () => {
  prepareWorkerStopLanding('wt', 'worker')(false)
  useAppStore.setState({ unifiedTabsByWorktree: { wt: [] } })
  expect(useAppStore.getState().activeWorktreeId).toBe('wt')
})
