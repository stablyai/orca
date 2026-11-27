import { describe, expect, it } from 'vitest'
import { isItsaplanInvalidApiKeyError } from './task-page-itsaplan-load-error'

describe('isItsaplanInvalidApiKeyError', () => {
  it('matches a revoked key behind the IPC error prefix', () => {
    expect(
      isItsaplanInvalidApiKeyError(
        "Error invoking remote method 'itsaplan:listIssues': Error: invalidApiKey: API key rejected"
      )
    ).toBe(true)
  })

  it('does not treat other failures as a bad key', () => {
    expect(isItsaplanInvalidApiKeyError('unreachable: invalidApiKey host')).toBe(false)
    expect(isItsaplanInvalidApiKeyError(null)).toBe(false)
  })
})
