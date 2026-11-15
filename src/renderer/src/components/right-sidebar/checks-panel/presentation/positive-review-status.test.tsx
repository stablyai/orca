// @vitest-environment happy-dom

import { act, useEffect, useState } from 'react'
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
  onRetry,
  contextKey = 'ctx'
}: {
  onRetry: () => Promise<ChecksPanelManualRefreshResult>
  contextKey?: string
}): React.JSX.Element {
  const [retrying, setRetrying] = useState(false)
  useEffect(() => setRetrying(false), [contextKey])
  return (
    <ChecksPanelPositiveReview
      detachedHeadDisplay={null}
      reviewShortLabel="PR"
      providerName="GitHub"
      reviewNumber={7}
      openReviewUrl="https://github.com/acme/widgets/pull/7"
      refresh={undefined}
      manualRefreshFailed={false}
      manualRetryInFlight={retrying}
      actionsDisabled={false}
      worktreeId="wt-1"
      recoveryContextKey={contextKey}
      onRetry={onRetry}
      setRetrying={setRetrying}
      retryBudgetMs={1_000}
    />
  )
}

function clickRetry(): void {
  Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Retry')
    ?.click()
}

function retryButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Retry'
  )
}

function spoken(): Element | null {
  return container.querySelector('[role="status"] span:not([aria-hidden])')
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
    vi.useRealTimers()
  })
  it('announces a repeated unusable result as a new outcome', async () => {
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 1 }
    })
    act(() => root.render(<Panel onRetry={() => Promise.resolve({ kind: 'read' as const })} />))
    const before = spoken()
    expect(before).not.toBeNull()
    await act(async () => clickRetry())
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'unusable' })
    expect(spoken()).not.toBeNull()
    expect(spoken()).not.toBe(before)
  })
  it('keeps a skipped retry unannounced', async () => {
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 1 }
    })
    act(() => root.render(<Panel onRetry={() => Promise.resolve({ kind: 'skipped' as const })} />))
    const before = spoken()
    await act(async () => clickRetry())
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'unusable' })
    expect(spoken()).toBe(before)
  })

  it('keeps a new context Retry disabled when an older context completes', async () => {
    vi.useFakeTimers()
    const oldRetry = Promise.withResolvers<ChecksPanelManualRefreshResult>()
    const newRetry = Promise.withResolvers<ChecksPanelManualRefreshResult>()
    store.setState({
      prDetailRecovery: { contextKey: 'ctx', status: { kind: 'unusable' }, terminalCount: 1 }
    })
    act(() => root.render(<Panel onRetry={() => oldRetry.promise} />))
    await act(async () => clickRetry())
    act(() => {
      store.setState({
        prDetailRecovery: { contextKey: 'next', status: { kind: 'unusable' }, terminalCount: 1 }
      })
      root.render(<Panel contextKey="next" onRetry={() => newRetry.promise} />)
    })
    await act(async () => clickRetry())
    await act(async () => oldRetry.resolve({ kind: 'read' }))
    expect(retryButton()?.getAttribute('aria-disabled')).toBe('true')

    await act(async () => newRetry.resolve({ kind: 'failed', errorType: 'network' }))
    expect(retryButton()?.getAttribute('aria-disabled')).toBeNull()
    expect(store.getState().prDetailRecovery?.status).toEqual({
      kind: 'failed',
      errorType: 'network'
    })
  })
})
