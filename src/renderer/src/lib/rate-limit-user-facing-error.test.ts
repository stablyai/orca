import { expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: () => 'translated error' }))

import { formatRateLimitUserFacingError } from './rate-limit-user-facing-error'

it('preserves the required workspace ID pattern', () => {
  expect(
    formatRateLimitUserFacingError(
      'Invalid workspace ID format: must match ^(org|wrk|wk)_[A-Za-z0-9]+$'
    )
  ).toBe('translated error: must match ^(org|wrk|wk)_[A-Za-z0-9]+$')
})
