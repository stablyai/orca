// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getUsageRosterTriggerAriaLabel } from './usage-roster-trigger-accessibility'

afterEach(cleanup)

function provider(
  providerId: ProviderRateLimits['provider'],
  status: ProviderRateLimits['status'] = 'ok'
): ProviderRateLimits {
  return {
    provider: providerId,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: status === 'error' ? 'request failed' : null,
    status
  }
}

describe('getUsageRosterTriggerAriaLabel', () => {
  it('includes pinned provider failures in the icon-only trigger accessible name', () => {
    render(
      <button
        aria-label={getUsageRosterTriggerAriaLabel([provider('codex', 'error'), provider('grok')])}
      >
        <span aria-hidden>C</span>
        <span aria-hidden>G</span>
      </button>
    )

    expect(screen.getByRole('button', { name: 'Usage. Codex: Refresh failed' })).toBeDefined()
  })

  it('uses the concise title when no pinned provider failed', () => {
    expect(getUsageRosterTriggerAriaLabel([provider('codex')])).toBe('Usage')
  })
})
