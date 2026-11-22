import { describe, expect, it } from 'vitest'
import { isCodexUsageSignInRequired } from './codex-auth-errors'

// Verbatim shape of the app-server error for a ChatGPT login the backend revoked.
const REVOKED_LOGIN_ERROR =
  'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Encountered invalidated oauth token for user, failing request", "type": null, "code": "token_revoked", "param": null }, "status": 401 }'

describe('isCodexUsageSignInRequired', () => {
  it('treats a revoked Codex login as needing sign-in, not as a rate limit', () => {
    expect(isCodexUsageSignInRequired({ provider: 'codex', error: REVOKED_LOGIN_ERROR })).toBe(true)
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
