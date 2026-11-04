// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  NativeChatVisualGuestThemePublisher,
  publishNativeChatVisualGuestTheme
} from './NativeChatVisualGuestThemePublisher'
import { readNativeChatVisualTheme } from './use-native-chat-visual-theme'

vi.mock('@/store/index', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({ settings: { theme: 'dark' }, noise: 0 })) }
})
vi.mock('./use-native-chat-visual-theme', () => ({
  readNativeChatVisualTheme: vi.fn(() => ({
    colorScheme: 'dark',
    tokens: { '--background': '#111' }
  }))
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('publishes once, ignores unrelated store writes, and updates only when resolved appearance changes', async () => {
  const publish = vi.fn()
  const api = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { nativeChat: { publishVisualGuestTheme: publish } }
  })
  try {
    render(<NativeChatVisualGuestThemePublisher />)
    expect(publish).toHaveBeenCalledTimes(1)
    const reads = vi.mocked(readNativeChatVisualTheme).mock.calls.length
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Missing test settings')
    }
    act(() => {
      for (let n = 0; n < 100; n++) {
        useAppStore.setState({
          settings: { ...settings, terminalFontSize: n }
        })
      }
    })
    expect(readNativeChatVisualTheme).toHaveBeenCalledTimes(reads)
    publishNativeChatVisualGuestTheme()
    expect(publish).toHaveBeenCalledTimes(1)
    vi.mocked(readNativeChatVisualTheme).mockReturnValue({
      colorScheme: 'light',
      tokens: { '--background': '#fff' }
    })
    await act(async () => {
      document.documentElement.classList.add('theme-changed')
    })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.native-chat-appearance')).toBeNull()
  } finally {
    document.documentElement.classList.remove('theme-changed')
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  }
})
