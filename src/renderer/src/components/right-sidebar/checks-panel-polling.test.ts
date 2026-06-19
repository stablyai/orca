import { describe, expect, it } from 'vitest'

import type { PRCheckDetail } from '../../../../shared/types'
import {
  CHECKS_PANEL_BASE_POLL_INTERVAL_MS,
  CHECKS_PANEL_MAX_POLL_INTERVAL_MS,
  nextChecksPanelPollInterval
} from './checks-panel-polling'

describe('nextChecksPanelPollInterval', () => {
  it('keeps repeated empty results at the baseline poll interval', () => {
    expect(
      nextChecksPanelPollInterval({
        checks: [],
        previousSignature: '[]',
        currentIntervalMs: CHECKS_PANEL_MAX_POLL_INTERVAL_MS
      })
    ).toEqual({ intervalMs: CHECKS_PANEL_BASE_POLL_INTERVAL_MS, signature: '[]' })
  })

  it('backs off repeated non-empty results up to the maximum interval', () => {
    const checks: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ]
    const { signature } = nextChecksPanelPollInterval({
      checks,
      previousSignature: '',
      currentIntervalMs: CHECKS_PANEL_BASE_POLL_INTERVAL_MS
    })

    expect(
      nextChecksPanelPollInterval({
        checks,
        previousSignature: signature,
        currentIntervalMs: CHECKS_PANEL_BASE_POLL_INTERVAL_MS
      }).intervalMs
    ).toBe(CHECKS_PANEL_BASE_POLL_INTERVAL_MS * 2)
    expect(
      nextChecksPanelPollInterval({
        checks,
        previousSignature: signature,
        currentIntervalMs: CHECKS_PANEL_MAX_POLL_INTERVAL_MS
      }).intervalMs
    ).toBe(CHECKS_PANEL_MAX_POLL_INTERVAL_MS)
  })

  it('resets changed non-empty results to the baseline poll interval', () => {
    const previous: PRCheckDetail[] = [
      { name: 'build', status: 'queued', conclusion: null, url: null }
    ]
    const next: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ]
    const { signature } = nextChecksPanelPollInterval({
      checks: previous,
      previousSignature: '',
      currentIntervalMs: CHECKS_PANEL_BASE_POLL_INTERVAL_MS
    })

    expect(
      nextChecksPanelPollInterval({
        checks: next,
        previousSignature: signature,
        currentIntervalMs: CHECKS_PANEL_MAX_POLL_INTERVAL_MS
      }).intervalMs
    ).toBe(CHECKS_PANEL_BASE_POLL_INTERVAL_MS)
  })
})
