// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ProviderPanel } from './provider-usage-panel'

vi.mock('./usage-meter', () => ({
  UsageDisplayToggle: () => null,
  UsageBar: () => null,
  UsageValue: () => null
}))
afterEach(cleanup)

const signedOut: ProviderRateLimits = {
  provider: 'claude',
  status: 'error',
  session: null,
  weekly: null,
  error: 'missing',
  updatedAt: 1,
  usageMetadata: { failureKind: 'missing-credentials' }
}

it('puts the fix beside a usage error the account card cannot read past', () => {
  render(
    <ProviderPanel p={signedOut} embedded errorAction={<button type="button">Sign in</button>} />
  )
  expect(screen.getByText('Sign in again')).toBeTruthy()
  expect(screen.getByText('This account needs you to sign in again.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
})

it('drops the fix once usage reads again', () => {
  render(
    <ProviderPanel
      p={{
        ...signedOut,
        status: 'ok',
        error: null,
        usageMetadata: undefined,
        weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }}
      embedded
      errorAction={<button type="button">Sign in</button>}
    />
  )
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
})
