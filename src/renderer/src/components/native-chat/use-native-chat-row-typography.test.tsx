// @vitest-environment happy-dom
import { useMemo, useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatRowTypography } from './use-native-chat-row-typography'

const measurements = vi.hoisted((): { onWidth?: (width: number | null) => void } => ({}))
vi.mock('../right-sidebar/right-sidebar-measured-width', () => ({
  useMeasuredWidth: (onWidth: (width: number | null) => void) => {
    measurements.onWidth = onWidth
    return () => undefined
  }
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settings: object }) => unknown) => selector({ settings: {} })
}))
afterEach(cleanup)

describe('chat row typography during resizing', () => {
  it('preserves the slot memo on default-width mount and pixel resizes, then refreshes for a new bucket', () => {
    let slotBuilds = 0
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(null)
      const { typography } = useNativeChatRowTypography(ref)
      const slots = useMemo(() => {
        slotBuilds += 1
        return { typography }
      }, [typography])
      return slots
    })
    const initial = result.current
    act(() => measurements.onWidth?.(736))
    expect(result.current).toBe(initial)
    expect(slotBuilds).toBe(1)
    act(() => measurements.onWidth?.(735))
    const narrower = result.current
    act(() => measurements.onWidth?.(734))
    act(() => measurements.onWidth?.(733))
    expect(result.current).toBe(narrower)
    expect(slotBuilds).toBe(2)
    expect(narrower).not.toBe(initial)
    act(() => measurements.onWidth?.(672))
    expect(slotBuilds).toBe(3)
    expect(result.current).not.toBe(narrower)
  })
})
