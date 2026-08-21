import { describe, expect, it } from 'vitest'
import { pluginConsentRequestSchema } from './plugin-consent-request'

describe('pluginConsentRequestSchema', () => {
  it('requires the exact reviewed consent fingerprint', () => {
    expect(
      pluginConsentRequestSchema.safeParse({
        pluginKey: 'mcode-samples.demo',
        decision: 'approve'
      }).success
    ).toBe(false)
    expect(
      pluginConsentRequestSchema.safeParse({
        pluginKey: 'mcode-samples.demo',
        reviewedFingerprint: '',
        decision: 'approve'
      }).success
    ).toBe(false)
  })

  it('accepts an explicit opaque fingerprint and rejects contract drift', () => {
    expect(
      pluginConsentRequestSchema.parse({
        pluginKey: 'mcode-samples.demo',
        reviewedFingerprint: 'sha256-reviewed',
        decision: 'keep-disabled'
      })
    ).toEqual({
      pluginKey: 'mcode-samples.demo',
      reviewedFingerprint: 'sha256-reviewed',
      decision: 'keep-disabled'
    })
    expect(() =>
      pluginConsentRequestSchema.parse({
        pluginKey: 'mcode-samples.demo',
        reviewedFingerprint: 'sha256-reviewed',
        decision: 'approve',
        unexpected: true
      })
    ).toThrow()
  })
})
