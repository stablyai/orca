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
})

function registerForTest(provider: () => string | null | undefined): void {
  unregisterCallbacks.push(registerFileSearchSelectedTextProvider(provider))
}

describe('normalizeSelectedTextForFileSearch', () => {
  it('bounds newline-heavy selected text without splitting it into arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const selectedText = Array.from({ length: 2000 }, (_, index) => `term-${index + 1}`).join('\n')

    const normalized = normalizeSelectedTextForFileSearch(selectedText)

    expect(normalized?.startsWith('term-1 term-2 term-3')).toBe(true)
    expect(normalized?.length).toBe(2048)
    expect(split).not.toHaveBeenCalled()
  })
})

describe('getSelectedTextForFileSearch', () => {
  it('unregisters providers so closed editors do not accumulate stale selection readers', () => {
    registerForTest(() => 'active')
    const unregister = registerFileSearchSelectedTextProvider(() => 'stale')
    unregisterCallbacks.push(unregister)
    expect(getSelectedTextForFileSearch()).toBe('stale')
    unregister()

    expect(getSelectedTextForFileSearch()).toBe('active')
  })
})
