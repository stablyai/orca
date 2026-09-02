import { describe, expect, it } from 'vitest'
import { isAiVaultPrepareSessionResumeUnavailableError } from './ai-vault-resume-preparation'

describe('isAiVaultPrepareSessionResumeUnavailableError', () => {
  it('recognizes deterministic old-host responses', () => {
    expect(
      isAiVaultPrepareSessionResumeUnavailableError({
        code: 'forbidden',
        message: "Method 'aiVault.prepareSessionResume' is not available to mobile clients"
      })
    ).toBe(true)
    expect(
      isAiVaultPrepareSessionResumeUnavailableError({
        code: 'method_not_found',
        message: 'Unknown method: aiVault.prepareSessionResume'
      })
    ).toBe(true)
  })

  it.each([
    {
      code: 'forbidden',
      message: "Method 'aiVault.listSessions' is not available to mobile clients"
    },
    { code: 'forbidden', message: 'Session resume is forbidden' },
    { code: 'internal_error', message: 'Method not found while preparing session' }
  ])('rejects a non-capability error: $code / $message', (error) => {
    expect(isAiVaultPrepareSessionResumeUnavailableError(error)).toBe(false)
  })
})
