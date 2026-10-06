// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import * as terminalThemeSelection from '../../../../shared/terminal-theme-selection'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { resetSystemPrefersDarkSubscriptionForTests } from '../terminal-pane/use-system-prefers-dark'
import { useNativeChatAppearanceStyle } from './native-chat-appearance-style'

afterEach(() => {
  cleanup()
  resetSystemPrefersDarkSubscriptionForTests()
  vi.restoreAllMocks()
})

describe('shared chat appearance hook', () => {
  it('updates every consumer from one system-scheme subscription', () => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const matches = vi.spyOn(media, 'matches', 'get').mockReturnValue(true)
    vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const addListener = vi.spyOn(media, 'addEventListener')
    const removeListener = vi.spyOn(media, 'removeEventListener')
    const settings = createGlobalSettingsFixture({
      theme: 'system',
      terminalUseSeparateLightTheme: true,
      terminalThemeDark: 'Builtin Tango Dark',
      terminalThemeLight: 'Builtin Tango Light',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    const chat = renderHook(() => useNativeChatAppearanceStyle(settings))
    const anotherChat = renderHook(() => useNativeChatAppearanceStyle(settings))
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(chat.result.current.colorScheme).toBe('dark')
    const darkBackground = chat.result.current['--chat-source-background']
    act(() => {
      matches.mockReturnValue(false)
      media.dispatchEvent(new MediaQueryListEvent('change', { matches: false }))
    })
    expect(chat.result.current.colorScheme).toBe('light')
    expect(chat.result.current['--chat-source-background']).not.toBe(darkBackground)
    expect(chat.result.current['--chat-foreground-mix']).toBe('100%')
    expect(anotherChat.result.current).toEqual(chat.result.current)
    chat.unmount()
    expect(removeListener).not.toHaveBeenCalled()
    anotherChat.unmount()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })
  it('keeps the style and palette resolution stable across unrelated settings and render changes', () => {
    const resolveColors = vi.spyOn(terminalThemeSelection, 'resolveConfiguredTerminalColors')
    const settings = createGlobalSettingsFixture({
      theme: 'dark',
      nativeChatAppearance: { matchTerminalInterface: true },
      terminalFontFamily: 'Consolas'
    })
    const { result, rerender } = renderHook(
      ({ settings, width }: { settings: GlobalSettings; width?: number }) =>
        useNativeChatAppearanceStyle(settings, width),
      { initialProps: { settings, width: 736 } }
    )
    const style = result.current
    expect(resolveColors).toHaveBeenCalledTimes(1)
    rerender({
      settings: { ...settings, terminalFontSize: settings.terminalFontSize + 1 },
      width: 736
    })
    expect(result.current).not.toBe(style)
    expect(result.current['--chat-font-size']).toBe(`${settings.terminalFontSize + 1}px`)
    expect(resolveColors).toHaveBeenCalledTimes(2)
    rerender({ settings: { ...settings, terminalFontFamily: 'Menlo' }, width: 736 })
    expect(result.current['--chat-code-font-family']).toContain('Menlo')
    expect(resolveColors).toHaveBeenCalledTimes(3)
    rerender({ settings: { ...settings, terminalFontFamily: 'Menlo' }, width: 384 })
    expect(result.current['--chat-estimated-chars-per-line']).toBe(50)
    expect(resolveColors).toHaveBeenCalledTimes(4)
    const narrower = result.current
    rerender({ settings: { ...settings, terminalFontFamily: 'Menlo' }, width: 399 })
    expect(result.current).toBe(narrower)
    expect(resolveColors).toHaveBeenCalledTimes(4)
  })

  it('invalidates the style for each appearance input', () => {
    const settings = createGlobalSettingsFixture({
      theme: 'dark',
      terminalThemeDark: 'Builtin Tango Dark',
      terminalThemeLight: '',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    const updates: Partial<GlobalSettings>[] = [
      { theme: 'light' },
      { terminalThemeDark: 'Builtin Tango Light' },
      { terminalThemeLight: 'Builtin Tango Light' },
      { terminalUseSeparateLightTheme: !settings.terminalUseSeparateLightTheme },
      { terminalCustomThemes: [] },
      { terminalColorOverrides: { background: '#122033', foreground: '#ddeeff' } },
      { terminalFontFamily: 'Menlo' },
      { terminalFontSize: settings.terminalFontSize + 1 },
      { nativeChatAppearance: { matchTerminalInterface: true, contrast: 120 } }
    ]
    const { result, rerender } = renderHook(
      (settings: GlobalSettings) => useNativeChatAppearanceStyle(settings),
      { initialProps: settings }
    )
    for (const update of updates) {
      rerender(settings)
      const style = result.current
      rerender({ ...settings, ...update })
      expect(result.current, Object.keys(update).join(',')).not.toBe(style)
    }
  })

  it('ignores terminal size changes while matching is off', () => {
    const settings = createGlobalSettingsFixture({ nativeChatAppearance: { fontSize: 18 } })
    const { result, rerender } = renderHook(
      (current: GlobalSettings) => useNativeChatAppearanceStyle(current),
      { initialProps: settings }
    )
    const style = result.current
    rerender({ ...settings, terminalFontSize: settings.terminalFontSize + 1 })
    expect(result.current).toBe(style)
  })
})
