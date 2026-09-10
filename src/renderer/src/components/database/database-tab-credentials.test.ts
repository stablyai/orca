import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDatabaseTabPassword,
  getDatabaseTabPassword,
  setDatabaseTabPassword
} from './database-tab-credentials'

afterEach(() => {
  clearDatabaseTabPassword('tab-a')
})

describe('database tab credentials', () => {
  it('does not reuse an in-memory password after a tab changes execution owner', () => {
    setDatabaseTabPassword('tab-a', 'first-owner-secret', 'runtime-a')
    expect(getDatabaseTabPassword('tab-a', 'runtime-a')).toBe('first-owner-secret')
    expect(getDatabaseTabPassword('tab-a', 'runtime-b')).toBe('')
    expect(getDatabaseTabPassword('tab-a')).toBe('')
    setDatabaseTabPassword('tab-a', 'second-owner-secret', 'runtime-b')
    expect(getDatabaseTabPassword('tab-a', 'runtime-a')).toBe('')
    clearDatabaseTabPassword('tab-a')
    expect(getDatabaseTabPassword('tab-a', 'runtime-b')).toBe('')
  })
  it('keeps passwords in the process-local vault until the tab closes', () => {
    expect(getDatabaseTabPassword('tab-a')).toBe('')
    setDatabaseTabPassword('tab-a', 'secret')
    expect(getDatabaseTabPassword('tab-a')).toBe('secret')
    clearDatabaseTabPassword('tab-a')
    expect(getDatabaseTabPassword('tab-a')).toBe('')
  })

  it('removes an entry when the password is cleared', () => {
    setDatabaseTabPassword('tab-a', 'secret')
    setDatabaseTabPassword('tab-a', '')
    expect(getDatabaseTabPassword('tab-a')).toBe('')
  })
})
