import { describe, expect, it } from 'vitest'
import { pluginConsentRequestSchema } from './plugin-consent-request'

describe('pluginConsentRequestSchema', () => {
  it('requires a nonempty reviewed consent fingerprint', () => {
    expect(
      pluginConsentRequestSchema.safeParse({
        pluginKey: 'samples.demo',
        decision: 'approve'
      }).success
    ).toBe(false)
    expect(
      pluginConsentRequestSchema.safeParse({
        pluginKey: 'samples.demo',
        reviewedFingerprint: '',
        decision: 'approve'
      }).success
    ).toBe(false)
  })

  it('accepts an explicit opaque fingerprint and ignores fields from newer clients', () => {
    expect(
      pluginConsentRequestSchema.parse({
        pluginKey: 'samples.demo',
        reviewedFingerprint: 'sha256-reviewed',
        decision: 'keep-disabled'
      })
    ).toEqual({
      pluginKey: 'samples.demo',
      reviewedFingerprint: 'sha256-reviewed',
      decision: 'keep-disabled'
    })
    expect(
      pluginConsentRequestSchema.parse({
        pluginKey: 'samples.demo',
        reviewedFingerprint: 'sha256-reviewed',
        decision: 'approve',
        reviewSurface: ['panels']
      })
    ).toEqual({
      pluginKey: 'samples.demo',
      reviewedFingerprint: 'sha256-reviewed',
      decision: 'approve'
    })
  })
})
