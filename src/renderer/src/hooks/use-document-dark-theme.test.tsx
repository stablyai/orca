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

import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { useDocumentDarkTheme, useSettingsDarkTheme } from './use-document-dark-theme'

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
  usePluginViewCaptureStore.getState().end()
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
})

describe('a plugin shot --theme capture', () => {
  it('paints its mode while it runs, then the setting again', () => {
    settingsState.theme = 'light'
    installMatchMedia(false)
    const { result } = renderHook(() => [useSettingsDarkTheme(), useDocumentDarkTheme()])
    expect(result.current).toEqual([false, false])
    act(() => usePluginViewCaptureStore.getState().begin({ panelWidth: null, dark: true }))
    expect(result.current).toEqual([true, true])
    act(() => usePluginViewCaptureStore.getState().end())
    expect(result.current).toEqual([false, false])
  })
})
