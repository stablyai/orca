import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useRepositoryAddScriptResultStore,
  type RepositoryAddScriptResultView
} from './repository-add-script-result'

function makeResult(exitCode: number): RepositoryAddScriptResultView {
  return {
    status: 'failed',
    path: '/work/repo',
    hostLabel: 'This computer',
    exitCode,
    output: '',
    outputTruncated: false
  }
}

describe('repository add script result queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useRepositoryAddScriptResultStore.setState({ result: null, queued: [], dismissAllowedAt: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses a queued dismissal until the guard window closes, then shows and clears it', () => {
    const { showRepositoryAddScriptResult, dismissRepositoryAddScriptResult } =
      useRepositoryAddScriptResultStore.getState()
    showRepositoryAddScriptResult(makeResult(1))
    showRepositoryAddScriptResult(makeResult(2))

    dismissRepositoryAddScriptResult()
    expect(useRepositoryAddScriptResultStore.getState().result?.exitCode).toBe(2)

    // Why: pin the guard window itself; deriving it from the constant would follow any change.
    vi.advanceTimersByTime(349)
    dismissRepositoryAddScriptResult()
    expect(useRepositoryAddScriptResultStore.getState().result?.exitCode).toBe(2)

    vi.advanceTimersByTime(1)
    dismissRepositoryAddScriptResult()
    expect(useRepositoryAddScriptResultStore.getState().result).toBeNull()
    expect(useRepositoryAddScriptResultStore.getState().queued).toEqual([])
  })

  it('keeps an unread result when a newer one arrives', () => {
    const { showRepositoryAddScriptResult } = useRepositoryAddScriptResultStore.getState()
    showRepositoryAddScriptResult(makeResult(1))
    showRepositoryAddScriptResult(makeResult(2))
    showRepositoryAddScriptResult(makeResult(3))

    const state = useRepositoryAddScriptResultStore.getState()
    expect(state.result?.exitCode).toBe(1)
    expect(state.queued.map((queued) => queued.exitCode)).toEqual([2, 3])
  })

  it('does nothing when dismissed with no result on screen', () => {
    useRepositoryAddScriptResultStore.getState().dismissRepositoryAddScriptResult()

    expect(useRepositoryAddScriptResultStore.getState()).toMatchObject({
      result: null,
      queued: [],
      dismissAllowedAt: 0
    })
  })
})
