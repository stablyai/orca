import { describe, expect, it } from 'vitest'
import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { createUiViewActions } from './ui-slice-view-actions'

function createHarness(): { getState: () => Partial<UISlice> } {
  let state: Partial<UISlice> = {
    activeView: 'terminal',
    previousViewBeforeActivity: 'terminal',
    pendingOrchestrationDeepLink: null
  }
  const set: UISliceSet = (updater) => {
    const next = typeof updater === 'function' ? updater(state as UISlice) : updater
    state = { ...state, ...next }
  }
  const get: UISliceGet = () => state as unknown as ReturnType<UISliceGet>
  state = {
    ...state,
    ...createUiViewActions(set, get)
  }
  return { getState: () => state }
}

describe('openOrchestrationDeepLink', () => {
  it('opens activity view and stores intent when handling orchestration-new deep link', () => {
    const harness = createHarness()

    harness.getState().openOrchestrationDeepLink?.({
      type: 'orchestration-new',
      title: 'Fix issue',
      repo: 'my-project'
    })

    expect(harness.getState().activeView).toBe('activity')
    expect(harness.getState().pendingOrchestrationDeepLink).toEqual({
      type: 'orchestration-new',
      title: 'Fix issue',
      repo: 'my-project'
    })

    harness.getState().clearPendingOrchestrationDeepLink?.()
    expect(harness.getState().pendingOrchestrationDeepLink).toBeNull()
  })
})
