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
