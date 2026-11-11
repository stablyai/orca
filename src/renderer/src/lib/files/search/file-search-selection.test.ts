import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSelectedTextForFileSearch,
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
