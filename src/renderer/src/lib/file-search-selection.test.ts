import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSelectedTextForFileSearch,
  normalizeSelectedTextForFileSearch,
  registerFileSearchSelectedTextProvider
} from './file-search-selection'

const unregisterCallbacks: (() => void)[] = []

afterEach(() => {
  while (unregisterCallbacks.length > 0) {
    unregisterCallbacks.pop()?.()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function registerForTest(provider: () => string | null | undefined): void {
  unregisterCallbacks.push(registerFileSearchSelectedTextProvider(provider))
}

describe('normalizeSelectedTextForFileSearch', () => {
  it('trims and collapses multi-line selections into the single-line search box shape', () => {
    expect(normalizeSelectedTextForFileSearch('  foo\r\n  bar\n\n baz  ')).toBe('foo bar baz')
  })

  it('returns null for empty selections', () => {
    expect(normalizeSelectedTextForFileSearch(' \n\t ')).toBeNull()
    expect(normalizeSelectedTextForFileSearch(null)).toBeNull()
  })
})

describe('getSelectedTextForFileSearch', () => {
  it('uses the most recently registered non-empty provider', () => {
    registerForTest(() => 'older')
    registerForTest(() => 'newer')

    expect(getSelectedTextForFileSearch()).toBe('newer')
  })

  it('falls back through empty providers', () => {
    registerForTest(() => 'needle')
    registerForTest(() => ' ')

    expect(getSelectedTextForFileSearch()).toBe('needle')
  })

  it('unregisters providers so closed editors do not accumulate stale selection readers', () => {
    const unregister = registerFileSearchSelectedTextProvider(() => 'stale')
    unregister()

    registerForTest(() => 'active')

    expect(getSelectedTextForFileSearch()).toBe('active')
  })

  it('falls back to the DOM selection when no provider has selected text', () => {
    vi.stubGlobal('window', {
      getSelection: () => ({
        toString: () => 'dom selection'
      })
    })

    expect(getSelectedTextForFileSearch()).toBe('dom selection')
  })
})
