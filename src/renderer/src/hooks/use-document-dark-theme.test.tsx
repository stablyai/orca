// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSystemPrefersDarkSubscriptionForTests } from '@/components/terminal-pane/use-system-prefers-dark'

const settingsState: { theme: 'system' | 'dark' | 'light' | undefined } = vi.hoisted(() => ({
  theme: 'system'
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: settingsState.theme ? { theme: settingsState.theme } : undefined
    })
}))

import { useDocumentDarkTheme } from './use-document-dark-theme'

function installMatchMedia(initialMatches: boolean): {
  emit: (matches: boolean) => void
} {
  let matches = initialMatches
  const listeners = new Set<EventListener>()
  const media = {
    get matches() {
      return matches
    },
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads `matches` and (un)subscribes to `change`.
  window.matchMedia = (() => media) as unknown as typeof window.matchMedia
  return {
    emit(next) {
      matches = next
      const event = new MediaQueryListEvent('change', { matches: next })
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  settingsState.theme = 'system'
  resetSystemPrefersDarkSubscriptionForTests()
  window.matchMedia = originalMatchMedia
})

describe('useDocumentDarkTheme', () => {
  it('follows a system color-scheme change while mounted', () => {
    const media = installMatchMedia(false)
    const { result } = renderHook(() => useDocumentDarkTheme())
    expect(result.current).toBe(false)

    act(() => media.emit(true))
    expect(result.current).toBe(true)

    act(() => media.emit(false))
    expect(result.current).toBe(false)
  })

  it.each([
    ['light', false],
    ['dark', true]
  ] as const)('keeps an explicit %s theme when the system flips', (theme, expected) => {
    settingsState.theme = theme
    const media = installMatchMedia(!expected)
    const { result } = renderHook(() => useDocumentDarkTheme())
    expect(result.current).toBe(expected)

    act(() => media.emit(expected))
    expect(result.current).toBe(expected)
    act(() => media.emit(!expected))
    expect(result.current).toBe(expected)
  })

  it('treats unloaded settings as system', () => {
    settingsState.theme = undefined
    installMatchMedia(true)
    const { result } = renderHook(() => useDocumentDarkTheme())
    expect(result.current).toBe(true)
  })
})
