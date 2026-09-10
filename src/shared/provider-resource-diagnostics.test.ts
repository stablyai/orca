import { describe, expect, it } from 'vitest'
import { parseProviderResourceDiagnosticResult } from './provider-resource-diagnostics'

describe('optional provider resource response boundary', () => {
  const response = {
    version: 1,
    requestId: 'request-a',
    verdict: 'unverifiable',
    reason: 'missing-retention'
  }

  it('rejects mismatched, unsupported, and authority-promoting responses', () => {
    for (const value of [null, {}, { ...response, version: 2 }, { ...response, verdict: 'live' }]) {
      expect(parseProviderResourceDiagnosticResult(value, 'request-a')).toBeNull()
    }
    expect(parseProviderResourceDiagnosticResult(response, 'request-b')).toBeNull()
  })

  it('drops unknown payloads and unvalidated facts before consumer logging', () => {
    const value = {
      ...response,
      extra: 'synthetic-private',
      epoch: 'synthetic-private',
      facts: { extra: 'synthetic-private' }
    }
    expect(parseProviderResourceDiagnosticResult(value, 'request-a')).toEqual(response)
  })
})
