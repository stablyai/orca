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
})
