import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTROL_ROOM_PREFERENCES,
  normalizeControlRoomPreferences,
  readControlRoomPreferences,
  writeControlRoomPreferences
} from './control-room-preferences'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  }
}

describe('control room preferences', () => {
  it('falls back safely and keeps only unique string pin identities', () => {
    expect(normalizeControlRoomPreferences(null)).toEqual(DEFAULT_CONTROL_ROOM_PREFERENCES)
    expect(
      normalizeControlRoomPreferences({
        scope: 'pinned',
        pinnedSessionKeys: ['one', 'one', '', 42, 'two']
      })
    ).toEqual({ version: 1, scope: 'pinned', pinnedSessionKeys: ['one', 'two'] })
  })

  it('round-trips the selected view and pins', () => {
    const storage = memoryStorage()
    writeControlRoomPreferences(storage, {
      version: 1,
      scope: 'all',
      pinnedSessionKeys: ['local:worktree:tab']
    })
    expect(readControlRoomPreferences(storage)).toEqual({
      version: 1,
      scope: 'all',
      pinnedSessionKeys: ['local:worktree:tab']
    })
  })

  it('recovers from malformed persisted data', () => {
    const storage = memoryStorage()
    storage.setItem('orca:control-room:v1', '{broken')
    expect(readControlRoomPreferences(storage)).toEqual(DEFAULT_CONTROL_ROOM_PREFERENCES)
  })
})
