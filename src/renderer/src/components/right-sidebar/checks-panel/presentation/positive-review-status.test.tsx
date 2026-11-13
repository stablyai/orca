// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = await vi.hoisted(async () => {
  const harness = await import('@/store/github/github-slice-test-harness')
  return { store: harness.createTestStore() }
})

vi.mock('@/store', () => ({ useAppStore: store }))

import { ChecksPanelPositiveReview } from './positive-review-status'
import type { ChecksPanelManualRefreshResult } from '../refresh/checks-panel-manual-refresh-result'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function Panel({
  onRetry
}: {
  onRetry: () => Promise<ChecksPanelManualRefreshResult>
}): React.JSX.Element {
  return (
    <ChecksPanelPositiveReview
      detachedHeadDisplay={null}
      reviewShortLabel="PR"
      providerName="GitHub"
      reviewNumber={7}
      openReviewUrl="https://github.com/acme/widgets/pull/7"
      refresh={undefined}
      manualRefreshFailed={false}
      manualRetryInFlight={false}
      actionsDisabled={false}
      worktreeId="wt-1"
      recoveryContextKey="ctx"
      onRetry={onRetry}
      setRetrying={() => {}}
      retryBudgetMs={1_000}
    />
  )
}

function clickRetry(): void {
  Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Retry')
    ?.click()
}

function spoken(): Element | null {
  return container.querySelector('[role="status"] .sr-only')
}

describe('ChecksPanelPositiveReview Retry', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps an unusable outcome after an unusable Retry and announces it again', async () => {
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 1 }
    })
    act(() => root.render(<Panel onRetry={() => Promise.resolve({ kind: 'read' as const })} />))
    const before = spoken()
    expect(before?.textContent).toBe("Details can't be shown here")

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })

    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'unusable' })
    expect(spoken()?.textContent).toBe("Details can't be shown here")
    expect(spoken()).not.toBe(before)
  })

  it('ignores recovery state recorded for another context', () => {
    store.setState({
      prDetailRecovery: { contextKey: 'other', status: { kind: 'timeout' }, terminalCount: 1 }
    })
    act(() => root.render(<Panel onRetry={() => Promise.resolve({ kind: 'read' as const })} />))
    expect(spoken()?.textContent).toBe('Details not loaded')
  })

  it('reports the real late result after a timeout, and ignores a Retry that did nothing', async () => {
    // Only the Retry budget timer is virtual; React keeps its real scheduler.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 1 }
    })
    const first = Promise.withResolvers<ChecksPanelManualRefreshResult>()
    const onRetry = vi
      .fn<() => Promise<ChecksPanelManualRefreshResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'skipped' })
    act(() => root.render(<Panel onRetry={onRetry} />))
    act(() => clickRetry())
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(spoken()?.textContent).toBe("GitHub didn't respond")

    // The first click still holds the refresh latch, so this one reads nothing and reports nothing.
    await act(async () => clickRetry())
    expect(spoken()?.textContent).toBe("GitHub didn't respond")
    expect(onRetry).toHaveBeenCalledTimes(1)

    await act(async () => first.resolve({ kind: 'failed', errorType: 'auth' }))
    expect(spoken()?.textContent).toBe('GitHub authentication failed')
    vi.useRealTimers()
  })

  it('ends a Retry whose GitHub read threw on failed copy', async () => {
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 1 },
      prRefreshStates: {}
    })
    act(() => root.render(<Panel onRetry={() => Promise.resolve({ kind: 'failed' as const })} />))
    await act(async () => clickRetry())
    expect(spoken()?.textContent).toBe("Couldn't load details")
  })

  it('restores the shown outcome, unannounced, when a Retry is latched out elsewhere', async () => {
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 3 }
    })
    act(() => root.render(<Panel onRetry={() => Promise.resolve({ kind: 'skipped' as const })} />))
    await act(async () => clickRetry())
    expect(spoken()?.textContent).toBe("Details can't be shown here")
    expect(store.getState().prDetailRecovery?.terminalCount).toBe(3)
  })
})
