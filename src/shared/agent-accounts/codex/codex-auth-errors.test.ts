import { describe, expect, it } from 'vitest'
import { isCodexUsageSignInRequired } from './codex-auth-errors'
import {
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from '../../agent-usage/status-copy/usage-error-copy'

// Verbatim shape of the app-server error for a ChatGPT login the backend revoked.
const REVOKED_LOGIN_ERROR =
  'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Encountered invalidated oauth token for user, failing request", "type": null, "code": "token_revoked", "param": null }, "status": 401 }'

describe('isCodexUsageSignInRequired', () => {
  it('treats a revoked Codex login as needing sign-in, not as a rate limit', () => {
    const usage = { provider: 'codex', error: REVOKED_LOGIN_ERROR }
    const translate = (_key: string, fallback: string): string => fallback
    expect(isCodexUsageSignInRequired(usage)).toBe(true)
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Sign in again')
    expect(getProviderUsageErrorMessage(usage, translate)).toBe(
      'This Codex sign-in is no longer valid. Sign in again to see usage.'
    )
  })

  it.each([
    'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized',
    'Encountered invalidated oauth token for user, failing request',
    'code: token_revoked'
  ])('recognizes the auth rejection from %s', (error) => {
    expect(isCodexUsageSignInRequired({ provider: 'codex', error })).toBe(true)
  })

  it('lets a structured failure kind or another provider outrank auth wording', () => {
    expect(
      isCodexUsageSignInRequired({
        provider: 'codex',
        error: REVOKED_LOGIN_ERROR,
        usageMetadata: { failureKind: 'usage-unavailable' }
      })
    ).toBe(false)
    expect(isCodexUsageSignInRequired({ provider: 'claude', error: REVOKED_LOGIN_ERROR })).toBe(
      false
    )
    expect(
      isCodexUsageSignInRequired({
        provider: 'codex',
        error: 'failed to fetch codex rate limits: error sending request for url'
      })
    ).toBe(false)
  })
})
