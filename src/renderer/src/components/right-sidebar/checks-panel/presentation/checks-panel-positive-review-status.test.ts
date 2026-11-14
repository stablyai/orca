import { describe, expect, it } from 'vitest'
import {
  getPositiveReviewPresentation,
  type PositiveReviewStatusInput
} from './checks-panel-positive-review-status'

const NOW = 1_000_000

function input(overrides: Partial<PositiveReviewStatusInput> = {}): PositiveReviewStatusInput {
  return {
    reviewShortLabel: 'PR',
    providerName: 'GitHub',
    reviewNumber: 7,
    openReviewUrl: 'https://github.com/acme/widgets/pull/7',
    recovery: null,
    manualRetryInFlight: false,
    refresh: undefined,
    now: NOW,
    formatTime: (at) => `T+${(at - NOW) / 1000}s`,
    ...overrides
  }
}

// UX-D1 state table: the title and actions stay fixed; only the status line, Retry blocking and spinner change.
const ROWS: [string, Partial<PositiveReviewStatusInput>, string, boolean, boolean][] = [
  ['queued', { recovery: { kind: 'waiting' } }, 'Waiting to load details', false, false],
  [
    'rate-gate',
    { recovery: { kind: 'paused', notBefore: NOW + 60_000 } },
    'GitHub limit reached. Loads at T+60s.',
    true,
    false
  ],
  ['admitted', { recovery: { kind: 'admitted' } }, 'Loading details…', true, true],
  ['failed', { recovery: { kind: 'failed' } }, "Couldn't load details", false, false],
  [
    'failed (classified)',
    { recovery: { kind: 'failed', errorType: 'auth' } },
    'GitHub authentication failed',
    false,
    false
  ],
  ['timeout', { recovery: { kind: 'timeout' } }, "GitHub didn't respond", false, false],
  [
    'read OK unusable',
    { recovery: { kind: 'unusable' } },
    "Details can't be shown here",
    false,
    false
  ],
  ['old host', { recovery: { kind: 'unsupported' } }, 'Details not loaded', false, false]
]

describe('getPositiveReviewPresentation', () => {
  it.each(ROWS)('%s', (_name, overrides, statusText, retryBlocked, spinner) => {
    const presentation = getPositiveReviewPresentation(input(overrides))
    expect(presentation.title).toBe('PR #7')
    expect(presentation.statusText).toBe(statusText)
    expect(presentation.retryBlocked).toBe(retryBlocked)
    expect(presentation.spinner).toBe(spinner)
    expect(presentation.open).toEqual({
      url: 'https://github.com/acme/widgets/pull/7',
      label: 'Open PR',
      ariaLabel: 'Open PR #7 on GitHub'
    })
  })

  it('names a numberless review and offers no Open without a trusted URL', () => {
    const presentation = getPositiveReviewPresentation(
      input({ reviewNumber: null, openReviewUrl: null, recovery: { kind: 'waiting' } })
    )
    expect(presentation.title).toBe('PR found')
    expect(presentation.open).toBeNull()
  })

  it('says Loads at only for a scheduled load and Retry at for a bare manual gate', () => {
    const manualGate = input({
      recovery: { kind: 'unusable' },
      refresh: { status: 'error', errorType: 'rate_limited', retryDisabledUntil: NOW + 5_000 }
    })
    expect(getPositiveReviewPresentation(manualGate).statusText).toBe(
      'GitHub limit reached. Retry at T+5s.'
    )
    expect(getPositiveReviewPresentation(manualGate).retryBlocked).toBe(true)
    expect(getPositiveReviewPresentation({ ...manualGate, now: NOW + 5_000 }).statusText).toBe(
      "Details can't be shown here"
    )
    const scheduled = input({
      refresh: {
        status: 'paused',
        nextAutoRetryAt: NOW + 9_000,
        retryDisabledUntil: NOW + 9_000
      }
    })
    expect(getPositiveReviewPresentation(scheduled).statusText).toBe(
      'GitHub limit reached. Loads at T+9s.'
    )
  })

  it('shows a deliberate Retry as loading even after automatic recovery closed', () => {
    const presentation = getPositiveReviewPresentation(
      input({ recovery: { kind: 'closed' }, manualRetryInFlight: true })
    )
    expect(presentation.statusText).toBe('Loading details…')
    expect(presentation.retryBlocked).toBe(true)
  })
})
