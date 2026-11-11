import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPEN_IN_APPLICATIONS,
  normalizeOpenInApplicationId,
  normalizeOpenInApplications
} from './open-in-applications'

describe('normalizeOpenInApplicationId', () => {
  it('trims a string id and treats anything else as no app', () => {
    expect(normalizeOpenInApplicationId(' zed ')).toBe('zed')
    expect(normalizeOpenInApplicationId('   ')).toBeNull()
    expect(normalizeOpenInApplicationId(undefined)).toBeNull()
    expect(normalizeOpenInApplicationId(42)).toBeNull()
  })
})

describe('normalizeOpenInApplications', () => {
  it('seeds defaults only when the persisted field is missing', () => {
    expect(normalizeOpenInApplications(undefined, { seedDefaults: true })).toEqual(
      DEFAULT_OPEN_IN_APPLICATIONS
    )
    expect(normalizeOpenInApplications([], { seedDefaults: true })).toEqual([])
  })
})
