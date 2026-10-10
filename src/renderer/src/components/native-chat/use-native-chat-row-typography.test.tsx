// @vitest-environment happy-dom
import { useMemo, useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as terminalThemeSelection from '../../../../shared/terminal-theme-selection'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '../../store'
import { resetSystemPrefersDarkSubscriptionForTests } from '../terminal-pane/use-system-prefers-dark'
import { useNativeChatRowTypography } from './use-native-chat-row-typography'

const originalSettings = useAppStore.getState().settings

afterEach(() => {
  cleanup()
  useAppStore.setState({ settings: originalSettings })
  resetSystemPrefersDarkSubscriptionForTests()
  vi.restoreAllMocks()
})

describe('memoized transcript row typography', () => {
  it('does no theme work on message renders or unrelated settings writes and follows text size and measured width', () => {
    const settings = createGlobalSettingsFixture({
      theme: 'dark',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    useAppStore.setState({ settings })
    const resolveColors = vi.spyOn(terminalThemeSelection, 'resolveConfiguredTerminalColors')
    const matchMedia = vi.spyOn(window, 'matchMedia')
    const rendered = vi.fn()
    const { result, rerender } = renderHook(() => {
      rendered()
      return useNativeChatRowTypography(useRef<HTMLDivElement>(null))
    })
    const initial = result.current.typography
    expect(resolveColors).toHaveBeenCalledTimes(1)
    const initialMediaReads = matchMedia.mock.calls.length
    rerender()
    rerender()
    expect(result.current.typography).toBe(initial)
    expect(resolveColors).toHaveBeenCalledTimes(1)
    expect(matchMedia).toHaveBeenCalledTimes(initialMediaReads)
    const renders = rendered.mock.calls.length
    const terminalSizeSettings = { ...settings, terminalFontSize: settings.terminalFontSize + 1 }
    act(() =>
      useAppStore.setState({
        settings: terminalSizeSettings
      })
    )
    expect(rendered).toHaveBeenCalledTimes(renders + 1)
    expect(result.current.typography.lineHeightPx).toBe((22 * 15) / 14)
    expect(resolveColors).toHaveBeenCalledTimes(2)
    act(() =>
      useAppStore.setState({
        settings: {
          ...terminalSizeSettings,
          nativeChatAppearance: { matchTerminalInterface: true, fontSize: 20 }
        }
      })
    )
    expect(result.current.typography.lineHeightPx).toBe((22 * 15) / 14)
    expect(resolveColors).toHaveBeenCalledTimes(3)
    const node = document.createElement('div')
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 384 }))
    act(() => result.current.measureContent(node))
    expect(result.current.typography.charsPerLine).toBe(46)
    expect(resolveColors).toHaveBeenCalledTimes(4)
    const measured = result.current.typography
    vi.mocked(node.getBoundingClientRect).mockReturnValue(DOMRect.fromRect({ width: 399 }))
    act(() => result.current.measureContent(node))
    expect(result.current.typography).toBe(measured)
    expect(resolveColors).toHaveBeenCalledTimes(4)
    act(() => result.current.measureContent(null))
  })

  it('preserves the slot memo on default-width mount and pixel resizes, then refreshes for a new bucket', () => {
    useAppStore.setState({ settings: createGlobalSettingsFixture() })
    let slotBuilds = 0
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(null)
      const { typography, measureContent } = useNativeChatRowTypography(ref)
      const slots = useMemo(() => {
        slotBuilds += 1
        return { typography }
      }, [typography])
      return { slots, measureContent }
    })
    const node = document.createElement('div')
    const bounds = vi.spyOn(node, 'getBoundingClientRect')
    const measure = (width: number) => {
      bounds.mockReturnValue(DOMRect.fromRect({ width }))
      act(() => result.current.measureContent(node))
    }
    const initial = result.current.slots
    measure(736)
    expect(result.current.slots).toBe(initial)
    expect(slotBuilds).toBe(1)
    measure(735)
    const narrower = result.current.slots
    measure(734)
    measure(733)
    expect(result.current.slots).toBe(narrower)
    expect(slotBuilds).toBe(2)
    expect(narrower).not.toBe(initial)
    measure(672)
    expect(slotBuilds).toBe(3)
    expect(result.current.slots).not.toBe(narrower)
    act(() => result.current.measureContent(null))
  })
})
