import { describe, expect, it } from 'vitest'
import {
  maestroRunPanelVisibilityStorageKey,
  readMaestroRunPanelVisibility,
  writeMaestroRunPanelVisibility
} from './maestro-run-panel-visibility'

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

describe('Maestro Run panel visibility', () => {
  it('scopes the preference to the execution host and workspace', () => {
    expect(maestroRunPanelVisibilityStorageKey('local', 'folder:one')).not.toBe(
      maestroRunPanelVisibilityStorageKey('ssh:host', 'folder:one')
    )
    expect(maestroRunPanelVisibilityStorageKey('local', 'folder:one')).not.toBe(
      maestroRunPanelVisibilityStorageKey('local', 'folder:two')
    )
  })

  it('persists every supported presentation without changing Run state', () => {
    const storage = memoryStorage()
    const key = maestroRunPanelVisibilityStorageKey('local', 'folder:one')

    for (const visibility of ['expanded', 'compact', 'hidden'] as const) {
      writeMaestroRunPanelVisibility(key, visibility, storage)
      expect(readMaestroRunPanelVisibility(key, storage)).toBe(visibility)
    }
  })

  it('falls back to expanded when storage is invalid or unavailable', () => {
    const key = maestroRunPanelVisibilityStorageKey('local', 'folder:one')
    const invalid = memoryStorage({ [key]: 'open' })
    const unavailable = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }

    expect(readMaestroRunPanelVisibility(key, invalid)).toBe('expanded')
    expect(readMaestroRunPanelVisibility(key, unavailable)).toBe('expanded')
    expect(() => writeMaestroRunPanelVisibility(key, 'hidden', unavailable)).not.toThrow()
  })
})
