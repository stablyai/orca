import {
  defineFixture,
  type ComponentFixture
} from '../../../../component-fixtures/component-fixture'
import type { PRDetailRecoveryStatus } from '@/store/github/pull-requests/pr-detail-recovery-context'
import { useState } from 'react'
import type { ChecksPanelRefreshInput } from '../checks-panel-review-state-model'
import type { ChecksPanelManualRefreshResult } from '../refresh/checks-panel-manual-refresh-result'
import { ChecksPanelPositiveReview } from './positive-review-status'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

type RowOptions = {
  reviewNumber?: number | null
  openReviewUrl?: string | null
  refresh?: ChecksPanelRefreshInput
  onRetry?: () => Promise<ChecksPanelManualRefreshResult>
  retryBudgetMs?: number
}

function Harness({ options }: { options: RowOptions }): React.JSX.Element {
  const [retrying, setRetrying] = useState(false)
  return (
    <div className="bg-sidebar">
      <ChecksPanelPositiveReview
        detachedHeadDisplay={null}
        reviewShortLabel="PR"
        providerName="GitHub"
        reviewNumber={options.reviewNumber === undefined ? 7 : options.reviewNumber}
        openReviewUrl={
          options.openReviewUrl === undefined
            ? 'https://github.com/acme/widgets/pull/7'
            : options.openReviewUrl
        }
        refresh={options.refresh}
        manualRefreshFailed={false}
        manualRetryInFlight={retrying}
        actionsDisabled={false}
        worktreeId="fixture"
        recoveryContextKey="fixture"
        onRetry={options.onRetry ?? (() => Promise.resolve({ kind: 'read' as const }))}
        setRetrying={setRetrying}
        retryBudgetMs={options.retryBudgetMs}
      />
    </div>
  )
}

function row(
  status: PRDetailRecoveryStatus,
  width: number,
  options: RowOptions = {}
): ComponentFixture {
  return {
    width,
    store: { prDetailRecovery: { contextKey: 'fixture', status, terminalCount: 1 } },
    // The admitted row shows its spinner only after the loading delay.
    interact: settle,
    render: () => <Harness options={options} />
  }
}

async function clickRetry(frame: HTMLElement): Promise<void> {
  await settle()
  const retry = Array.from(frame.querySelectorAll('button')).find(
    (button) => button.textContent === 'Retry'
  )
  retry?.click()
  await settle()
}

// Rate-gate deadline in a stable local wall time so screenshots stay comparable.
const gate = new Date()
gate.setHours(14, 30, 0, 0)
if (gate.getTime() <= Date.now()) {
  gate.setDate(gate.getDate() + 1)
}

const ROWS: Record<string, PRDetailRecoveryStatus> = {
  queued: { kind: 'waiting' },
  rateGate: { kind: 'paused', notBefore: gate.getTime() },
  admitted: { kind: 'admitted' },
  failed: { kind: 'failed' },
  timeout: { kind: 'timeout' },
  unusable: { kind: 'unusable' },
  oldHost: { kind: 'unsupported' }
}

export const queued = row(ROWS.queued, 320)
export const rateGate = row(ROWS.rateGate, 320)
export const admitted = row(ROWS.admitted, 320)
export const failed = row(ROWS.failed, 320)
export const timeout = row(ROWS.timeout, 320)
export const unusable = row(ROWS.unusable, 320)
export const oldHost = row(ROWS.oldHost, 320)

export const queuedNarrow = row(ROWS.queued, 220)
export const rateGateNarrow = row(ROWS.rateGate, 220)
export const admittedNarrow = row(ROWS.admitted, 220)
export const failedNarrow = row(ROWS.failed, 220)
export const timeoutNarrow = row(ROWS.timeout, 220)
export const unusableNarrow = row(ROWS.unusable, 220)
export const oldHostNarrow = row(ROWS.oldHost, 220)

export const failedClassified = row({ kind: 'failed', errorType: 'auth' }, 320)
export const foundWithoutNumber = row({ kind: 'waiting' }, 320, {
  reviewNumber: null,
  openReviewUrl: null
})

/** Keyboard: Retry keeps focus while aria-disabled during an admitted read. */
export const keyboardRetryFocusAdmitted = defineFixture({
  ...row(ROWS.admitted, 320),
  interact: async (frame) => {
    await settle()
    const retry = Array.from(frame.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    retry?.focus()
    retry?.click()
  }
})

/** Unusable, then Retry reads again and finds nothing usable: same text, announced again. */
export const unusableRetryUnusable = defineFixture({
  ...row(ROWS.unusable, 320, {
    onRetry: () => new Promise((resolve) => setTimeout(() => resolve({ kind: 'read' }), 100))
  }),
  interact: clickRetry
})

/** Timeout, then a Retry that outlasts its budget reports GitHub didn't respond again. */
export const timeoutRetryTimeout = defineFixture({
  ...row(ROWS.timeout, 320, { onRetry: () => new Promise(() => {}), retryBudgetMs: 150 }),
  interact: clickRetry
})

/** A manual rate gate with no scheduled load: Retry at, not Loads at. */
export const retryOnlyRateGate = row(ROWS.unusable, 320, {
  refresh: { status: 'error', errorType: 'rate_limited', retryDisabledUntil: gate.getTime() }
})
