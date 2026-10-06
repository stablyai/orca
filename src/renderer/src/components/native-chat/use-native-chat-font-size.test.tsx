// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import type { KeybindingOverrides } from '../../../../shared/keybindings'

const mocks = vi.hoisted(() => {
  const settings: { nativeChatAppearance?: NativeChatAppearanceSettings } = {}
  const updateSettings = vi.fn(async (updates: typeof settings) => {
    Object.assign(settings, updates)
  })
  const bindings: { current?: KeybindingOverrides } = {}
  return { settings, updateSettings, bindings, web: true }
})
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ ...mocks, keybindings: mocks.bindings.current }) }
}))
import { useNativeChatFontSize } from './use-native-chat-font-size'
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
import { isMacPlatform } from './native-chat-shortcut'

function key(key: string, target: EventTarget = window): void {
  const code =
    key === '+'
      ? 'Equal'
      : key === '-' || key === '_'
        ? 'Minus'
        : key === '0'
          ? 'Digit0'
          : `Key${key.toUpperCase()}`
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      bubbles: true,
      cancelable: true,
      metaKey: isMacPlatform(),
      ctrlKey: !isMacPlatform(),
      shiftKey: key === '+' || key === '_'
    })
  )
}
afterEach(() => {
  cleanup()
  mocks.web = true
  delete mocks.bindings.current
  delete mocks.settings.nativeChatAppearance
  mocks.updateSettings.mockClear()
})

describe('persisted chat font-size shortcuts', () => {
  it('serializes quick repeats against the latest stored size, clamps, and resets only text size', async () => {
    mocks.settings.nativeChatAppearance = { fontSize: 19, codeFontSize: 16, width: 'wide' }
    renderHook(() => useNativeChatFontSize(true))
    act(() => {
      key('+')
      key('+')
      key('-')
    })
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(2))
    expect(mocks.settings.nativeChatAppearance).toEqual({
      fontSize: 19,
      codeFontSize: 16,
      width: 'wide'
    })
    act(() => key('0'))
    await waitFor(() =>
      expect(mocks.settings.nativeChatAppearance).toEqual({ codeFontSize: 16, width: 'wide' })
    )
  })
  it('writes an absent object on reset and ignores inactive panes', async () => {
    const { rerender } = renderHook(({ enabled }) => useNativeChatFontSize(enabled), {
      initialProps: { enabled: false }
    })
    key('+')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    rerender({ enabled: true })
    key('-')
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 13 }))
    key('0')
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toBeUndefined())
  })
  it('does not listen to desktop DOM keys that are handled by the IPC bridge', () => {
    mocks.web = false
    renderHook(() => useNativeChatFontSize(true))
    key('+')
    key('-')
    key('0')
    key('_')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })
  it('only handles keys originating in its chat root', async () => {
    const root = document.createElement('div')
    const input = document.createElement('input')
    root.append(input)
    document.body.append(root)
    renderHook(() => useNativeChatFontSize(true, { current: root }))
    key('+')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    key('-', input)
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 13 }))
    root.remove()
  })

  it('handles configured web bindings and leaves old or disabled chords alone', async () => {
    mocks.bindings.current = {
      'zoom.in': ['Mod+Y'],
      'zoom.out': ['Mod+U'],
      'zoom.reset': []
    }
    renderHook(() => useNativeChatFontSize(true))
    key('+')
    key('0')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    key('y')
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 15 }))
    key('u')
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toBeUndefined())
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2)
  })
})
