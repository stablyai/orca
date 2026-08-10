import { afterEach, describe, expect, it } from 'vitest'
import {
  readSshPortsShowOtherUsers,
  SSH_PORTS_SHOW_OTHER_USERS_STORAGE_KEY,
  writeSshPortsShowOtherUsers
} from './ssh-ports-other-users-preference'

function memoryStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  store: Record<string, string>
} {
  const store = { ...initial }
  return {
    store,
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = value
    }
  }
}

describe('ssh-ports-other-users-preference', () => {
  afterEach(() => {
    // no global side effects when storage is injected
  })

  it('defaults to false when unset', () => {
    expect(readSshPortsShowOtherUsers(memoryStorage())).toBe(false)
  })

  it('persists the toggle value', () => {
    const storage = memoryStorage()
    writeSshPortsShowOtherUsers(true, storage)
    expect(storage.store[SSH_PORTS_SHOW_OTHER_USERS_STORAGE_KEY]).toBe('true')
    expect(readSshPortsShowOtherUsers(storage)).toBe(true)
    writeSshPortsShowOtherUsers(false, storage)
    expect(readSshPortsShowOtherUsers(storage)).toBe(false)
  })
})
