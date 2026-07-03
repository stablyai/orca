import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_SEARCH_SELECTED_TEXT_MAX_CHARS,
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

  it('handles CR-only selected text line breaks', () => {
    expect(normalizeSelectedTextForFileSearch('  foo\r  bar\r\r baz  ')).toBe('foo bar baz')
  })

  it('returns null for empty selections', () => {
    expect(normalizeSelectedTextForFileSearch(' \n\t ')).toBeNull()
    expect(normalizeSelectedTextForFileSearch(null)).toBeNull()
  })

  it('bounds newline-heavy selected text without splitting it into arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const selectedText = Array.from({ length: 2000 }, (_, index) => `term-${index + 1}`).join('\n')

    const normalized = normalizeSelectedTextForFileSearch(selectedText)

    expect(normalized?.startsWith('term-1 term-2 term-3')).toBe(true)
    expect(normalized?.length).toBeLessThanOrEqual(FILE_SEARCH_SELECTED_TEXT_MAX_CHARS)
    expect(split).not.toHaveBeenCalled()
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
