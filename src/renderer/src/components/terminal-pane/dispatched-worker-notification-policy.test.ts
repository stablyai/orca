import { describe, expect, it } from 'vitest'
import {
  isDispatchedOrchestrationWorkerPane,
  shouldSuppressDispatchedWorkerNotification
} from './dispatched-worker-notification-policy'

const workerPaneKey = 'tab-1:leaf-1'
const coordinatorPaneKey = 'tab-2:leaf-2'
const dispatchContext = { taskId: 'task-1', dispatchId: 'dispatch-1' }

function makeState(overrides?: {
  dispatchedWorkerTaskComplete?: boolean
  runtime?: Record<string, typeof dispatchContext>
  live?: Record<string, { orchestration?: typeof dispatchContext }>
  retained?: Record<string, { entry?: { orchestration?: typeof dispatchContext } }>
}) {
  return {
    settings: {
      notifications: {
        dispatchedWorkerTaskComplete: overrides?.dispatchedWorkerTaskComplete ?? false
      }
    },
    runtimeAgentOrchestrationByPaneKey: overrides?.runtime ?? {
      [workerPaneKey]: dispatchContext
    },
    agentStatusByPaneKey: overrides?.live ?? {},
    retainedAgentsByPaneKey: overrides?.retained ?? {}
  }
}

describe('isDispatchedOrchestrationWorkerPane', () => {
  it('matches a pane the runtime holds a dispatch for', () => {
    expect(isDispatchedOrchestrationWorkerPane(makeState(), workerPaneKey)).toBe(true)
  })

  it('does not match the coordinator pane', () => {
    expect(isDispatchedOrchestrationWorkerPane(makeState(), coordinatorPaneKey)).toBe(false)
  })

  it('falls back to the live agent status when the runtime map is empty', () => {
    const state = makeState({
      runtime: {},
      live: { [workerPaneKey]: { orchestration: dispatchContext } }
    })
    expect(isDispatchedOrchestrationWorkerPane(state, workerPaneKey)).toBe(true)
  })

  it('falls back to a retained agent row after the live row is gone', () => {
    const state = makeState({
      runtime: {},
      retained: { [workerPaneKey]: { entry: { orchestration: dispatchContext } } }
    })
    expect(isDispatchedOrchestrationWorkerPane(state, workerPaneKey)).toBe(true)
  })

  it('needs a dispatch id, not just an orchestration context shell', () => {
    const state = makeState({
      runtime: {},
      live: { [workerPaneKey]: { orchestration: { taskId: 'task-1' } as typeof dispatchContext } }
    })
    expect(isDispatchedOrchestrationWorkerPane(state, workerPaneKey)).toBe(false)
  })

  it('matches nothing without a pane key', () => {
    expect(isDispatchedOrchestrationWorkerPane(makeState(), undefined)).toBe(false)
  })
})

describe('shouldSuppressDispatchedWorkerNotification', () => {
  it('suppresses a worker completion once the setting is off', () => {
    expect(shouldSuppressDispatchedWorkerNotification(makeState(), workerPaneKey)).toBe(true)
  })

  it('keeps the coordinator loud with the setting off', () => {
    expect(shouldSuppressDispatchedWorkerNotification(makeState(), coordinatorPaneKey)).toBe(false)
  })

  it('suppresses nothing while the setting is on', () => {
    const state = makeState({ dispatchedWorkerTaskComplete: true })
    expect(shouldSuppressDispatchedWorkerNotification(state, workerPaneKey)).toBe(false)
  })

  it('suppresses nothing when settings are missing', () => {
    const state = { runtimeAgentOrchestrationByPaneKey: { [workerPaneKey]: dispatchContext } }
    expect(shouldSuppressDispatchedWorkerNotification(state, workerPaneKey)).toBe(false)
  })
})
