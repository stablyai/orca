import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from '../../src/main/rate-limits/antigravity-usage-fetcher'
import { ANTIGRAVITY_LOCATION_REJECTION } from '../../src/main/rate-limits/antigravity-usage-location-rejection.test-fixtures'
import {
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from '../../src/renderer/src/components/status-bar/usage-error-copy'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// This crosses the host/renderer boundary; renderer unit tests consume only the shared contract.
describe('Antigravity CLI rejection to usage diagnostic', () => {
  beforeEach(() => resetAntigravityUsageSupportForTests())

  it('labels the captured rejection and preserves the specific CLI reason through the fetcher', async () => {
    const result = await fetchAntigravityRateLimits({
      resolveCommand: async () => '/test/agy',
      resolveEnvironment: async () => ({}),
      runCommand: async (spec) => ({
        signal: null,
        timedOut: false,
        ...(spec.args?.[0] === '--version'
          ? { code: 0, stdout: '1.4.7', stderr: '' }
          : ANTIGRAVITY_LOCATION_REJECTION)
      })
    })

    expect(getProviderUsageStatusLabel(result)).toBe('Usage unavailable')
    expect(getProviderUsageErrorMessage(result)).toContain(
      'The Antigravity CLI reports that Antigravity is not currently available in your location.'
    )
  })
})
