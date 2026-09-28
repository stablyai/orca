import { describe, expect, it } from 'vitest'
import { profileStateRecoveryRequestSchema } from './profile-state-recovery-command'

describe('offline recovery source selection', () => {
  it.each([
    { kind: 'current-json' },
    { kind: 'json', revision: 1 },
    { kind: 'sqlite', backupId: 'selected-backup' }
  ])('accepts an explicit source: %j', (selector) => {
    expect(
      profileStateRecoveryRequestSchema.parse({ userDataPath: '/profile', selector }).selector
    ).toEqual(selector)
  })

  it.each([
    { kind: 'current-json', revision: 1 },
    { kind: 'current-json', backupId: 'selected-backup' },
    { kind: 'current-json', path: '../different-profile/orca-data.json' },
    { kind: 'json', revision: null },
    { kind: 'json', revision: 0 },
    { kind: 'sqlite' },
    { kind: 'json' }
  ])('rejects ambiguous or incomplete sources: %j', (selector) => {
    expect(
      profileStateRecoveryRequestSchema.safeParse({ userDataPath: '/profile', selector }).success
    ).toBe(false)
  })
})
