import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import { getExtraUsageLabel } from './provider-extra-usage-section'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'
import {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'

function kiro(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'error',
    ...overrides
  }
}

describe('Kiro usage copy', () => {
  it('sends an expired Kiro login back to kiro-cli, which owns its token refresh', () => {
    const p = kiro({
      error:
        'Kiro CLI sign-in expired. Run kiro-cli on the computer running Orca, then retry usage.',
      usageMetadata: { failureKind: 'delegated-refresh-required', source: 'oauth' }
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Run Kiro to refresh')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Run kiro-cli in a terminal on the computer running Orca and wait for it to start. If prompted, sign in, then retry usage.'
    )
  })

  it('names the provider and its overage balance', () => {
    expect(getProviderDisplayName('kiro')).toBe('Kiro')
    expect(getExtraUsageLabel('kiro')).toBe('Overage')
  })

  it('has no Orca account settings to open, since kiro-cli owns the login', () => {
    expect(getUsageProviderAccountsSectionId('kiro')).toBeNull()
  })
})
