import { describe, expect, it } from 'vitest'
import { DEFAULT_OPEN_IN_APPLICATIONS, normalizeOpenInApplications } from './open-in-applications'

describe('normalizeOpenInApplications', () => {
  it('seeds defaults only when the persisted field is missing', () => {
    expect(normalizeOpenInApplications(undefined, { seedDefaults: true })).toEqual(
      DEFAULT_OPEN_IN_APPLICATIONS
    )
    expect(normalizeOpenInApplications([], { seedDefaults: true })).toEqual([])
  })
})
