// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorkerStopReceipt } from '../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  close: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  state: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('../terminal/tab-lifecycle/terminal-tab-actions', () => ({ closeTerminalTab: mocks.close }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: mocks.state } }))
vi.mock('sonner', () => ({ toast: { error: mocks.error, warning: mocks.warning } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { closeWorkerTab, stopWorker } from './worker-tab-explicit-actions'

const leafId = '00000000-0000-4000-8000-000000000001'
const tab: Tab = {
  id: 'worker',
  entityId: 'worker',
  groupId: 'group',
  worktreeId: 'workspace',
  contentType: 'terminal',
  label: 'Task',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  workerTab: {
    origin: {
      runId: 'run',
      taskId: 'task',
      dispatchId: 'dispatch',
      taskTitle: 'Task',
      workerLeafId: leafId,
      parent: { kind: 'pane', paneKey: 'coordinator:pane' },
      coordinator: { kind: 'pane', paneKey: 'coordinator:pane' }
    }
  }
}
const stopped: WorkerStopReceipt = {
  dispatchId: 'dispatch',
  state: 'stopped',
  alreadySettled: false,
  processAction: 'closed_agent_terminal'
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.state.mockReturnValue({
    unifiedTabsByWorktree: { workspace: [tab] },
    runtimeAgentOrchestrationByPaneKey: {}
  })
})

it('Stop worker uses the fenced host RPC and never closes a tab itself', async () => {
  mocks.rpc.mockResolvedValue(stopped)
  expect(await stopWorker('workspace', tab)).toBe('stopped')
  expect(mocks.rpc).toHaveBeenCalledWith(
    { kind: 'local' },
    'orchestration.workerStop',
    { dispatch: 'dispatch' },
    { suppressFeatureInteraction: true }
  )
  expect(mocks.close).not.toHaveBeenCalled()
})

it.each([
  ['stopped', stopped],
  [
    'already settled',
    { ...stopped, state: 'completed', alreadySettled: true, processAction: 'none' }
  ]
])('explicit Close proceeds after a %s receipt', async (_name, receipt) => {
  mocks.rpc.mockResolvedValue(receipt)
  await closeWorkerTab('workspace', tab)
  expect(mocks.close).toHaveBeenCalledWith(
    'worker',
    expect.objectContaining({ reason: 'user', endsWorker: true })
  )
  expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.close.mock.invocationCallOrder[0]!
  )
})

it.each([
  [
    'context only',
    {
      ...stopped,
      processAction: 'none',
      warning: 'Assignment stopped without closing the process.'
    }
  ],
  ['unknown', { ...stopped, state: 'stop_unknown', processAction: 'unknown' }],
  ['refused', null]
])('explicit Close keeps the tab after a %s receipt', async (_name, receipt) => {
  mocks.rpc.mockResolvedValue(receipt)
  await closeWorkerTab('workspace', tab)
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledOnce()
})

it('explicit Close keeps the tab when the fenced RPC fails', async () => {
  mocks.rpc.mockRejectedValue(new Error('host unavailable'))
  await closeWorkerTab('workspace', tab)
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledOnce()
})

it('a known stopped worker closes directly without another stop', async () => {
  mocks.state.mockReturnValue({
    unifiedTabsByWorktree: { workspace: [tab] },
    runtimeAgentOrchestrationByPaneKey: {
      [`worker:${leafId}`]: { dispatchId: 'dispatch', taskId: 'task', stopped: true }
    }
  })
  await closeWorkerTab('workspace', tab)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('helper failures produce feedback without overriding the parent stop receipt', async () => {
  mocks.rpc.mockResolvedValue({
    ...stopped,
    helpers: [{ dispatchId: 'helper', creatorDispatchId: 'dispatch', outcome: 'unconfirmed' }]
  })
  await closeWorkerTab('workspace', tab)
  expect(mocks.warning).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('refuses Stop and Close on a receiving-host attachment without invoking workerStop or closing its tab', async () => {
  const remote = {
    ...tab,
    workerTab: { origin: { ...tab.workerTab!.origin, stopRequiresHome: true as const } }
  }
  expect(await stopWorker('workspace', remote)).toBe('refused')
  await closeWorkerTab('workspace', remote)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledTimes(2)
})

it('closes a locally proven finished receiver after confirmation without a stop RPC', async () => {
  const remote = {
    ...tab,
    workerTab: { origin: { ...tab.workerTab!.origin, stopRequiresHome: true as const } }
  }
  mocks.state.mockReturnValue({
    unifiedTabsByWorktree: { workspace: [remote] },
    runtimeAgentOrchestrationByPaneKey: {
      [`worker:${leafId}`]: { dispatchId: 'dispatch', taskId: 'task', stopped: true }
    }
  })
  await closeWorkerTab('workspace', remote)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.close).toHaveBeenCalledWith('worker', {
    reason: 'user',
    endsWorker: true,
    skipRunningProcessConfirm: true
  })
})

it("does not mistake another Dispatch's finished context for proof a receiver worker finished", async () => {
  const remote = {
    ...tab,
    workerTab: { origin: { ...tab.workerTab!.origin, stopRequiresHome: true as const } }
  }
  mocks.state.mockReturnValue({
    unifiedTabsByWorktree: { workspace: [remote] },
    runtimeAgentOrchestrationByPaneKey: {
      [`worker:${leafId}`]: { dispatchId: 'replacement', taskId: 'replacement-task', stopped: true }
    }
  })
  await closeWorkerTab('workspace', remote)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
})
