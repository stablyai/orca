import { beforeEach, describe, expect, it } from 'vitest'
import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { createUiModalActions } from './ui-slice-modal-actions'
import { createUiViewActions } from './ui-slice-view-actions'

type HarnessState = Partial<UISlice> & {
  repos?: readonly { id: string; displayName?: string; path?: string }[]
}

function createHarness(): {
  getState: () => HarnessState
  setState: (patch: Partial<HarnessState>) => void
} {
  let state: HarnessState = {}
  const set: UISliceSet = (updater) => {
    const next = typeof updater === 'function' ? updater(state as UISlice) : updater
    state = { ...state, ...next }
  }
  const get: UISliceGet = () => state as unknown as ReturnType<UISliceGet>
  state = {
    repos: [],
    ...createUiModalActions(set, get),
    ...createUiViewActions(set, get)
  }
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch }
    }
  }
}

describe('openWorktreeDeepLink', () => {
  let harness = createHarness()

  beforeEach(() => {
    harness = createHarness()
  })

  it('opens new workspace composer with prefilled parameters when handling worktree-create deep link', () => {
    harness.getState().openWorktreeDeepLink?.({
      type: 'worktree-create',
      repo: 'my-project',
      name: 'feat/siri-shortcuts',
      branch: 'main'
    })

    expect(harness.getState().activeModal).toBe('new-workspace-composer')
    expect(harness.getState().modalData).toEqual({
      prefilledName: 'feat/siri-shortcuts',
      initialRepoId: 'my-project',
      initialBaseBranch: 'main',
      telemetrySource: 'unknown'
    })
  })

  it('resolves worktree-create deep link repo by displayName or path basename', () => {
    harness.setState({
      repos: [{ id: 'repo-uuid-1', displayName: 'Orca App', path: '/Users/dev/orca' }]
    })

    harness.getState().openWorktreeDeepLink?.({
      type: 'worktree-create',
      repo: 'orca',
      name: 'feat/deep-link',
      branch: 'main'
    })

    expect(harness.getState().modalData).toEqual({
      prefilledName: 'feat/deep-link',
      initialRepoId: 'repo-uuid-1',
      initialBaseBranch: 'main',
      telemetrySource: 'unknown'
    })
  })
})
