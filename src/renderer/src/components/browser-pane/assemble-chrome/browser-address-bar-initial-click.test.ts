import type { MouseEvent as ReactMouseEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  selectAddressBarCollapsedInitialClick,
  trackAddressBarInitialMouseDown
} from './browser-address-bar-initial-click'

function stubInput(
  overrides: {
    activeElement?: unknown
    selectionStart?: number | null
    selectionEnd?: number | null
  } = {}
) {
  const input = {
    ownerDocument: { activeElement: overrides.activeElement ?? null },
    selectionStart: overrides.selectionStart ?? 0,
    selectionEnd: overrides.selectionEnd ?? 0,
    select: vi.fn()
  }
  const event = {
    button: 0,
    currentTarget: input
  } as unknown as ReactMouseEvent<HTMLInputElement>
  return { input, event }
}

describe('browser-address-bar-initial-click', () => {
  it('arms the flag on a left click that starts outside the input', () => {
    const ref = { current: false }
    const { event } = stubInput()

    trackAddressBarInitialMouseDown(ref, event)

    expect(ref.current).toBe(true)
  })

  it('leaves the flag down when the click starts in the input itself', () => {
    const ref = { current: false }
    const { input, event } = stubInput()
    input.ownerDocument.activeElement = input

    trackAddressBarInitialMouseDown(ref, event)

    expect(ref.current).toBe(false)
  })

  it('ignores non-left buttons', () => {
    const ref = { current: false }
    const { event } = stubInput()
    const rightClick = { ...event, button: 2 } as unknown as ReactMouseEvent<HTMLInputElement>

    trackAddressBarInitialMouseDown(ref, rightClick)

    expect(ref.current).toBe(false)
  })

  it('selects a collapsed initial click and disarms', () => {
    const ref = { current: true }
    const { input, event } = stubInput({ selectionStart: 3, selectionEnd: 3 })

    selectAddressBarCollapsedInitialClick(ref, event)

    expect(input.select).toHaveBeenCalledOnce()
    expect(ref.current).toBe(false)
  })

  it('keeps a drag selection and still disarms', () => {
    const ref = { current: true }
    const { input, event } = stubInput({ selectionStart: 1, selectionEnd: 5 })

    selectAddressBarCollapsedInitialClick(ref, event)

    expect(input.select).not.toHaveBeenCalled()
    expect(ref.current).toBe(false)
  })

  it('does nothing when no initial click was armed', () => {
    const ref = { current: false }
    const { input, event } = stubInput()

    selectAddressBarCollapsedInitialClick(ref, event)

    expect(input.select).not.toHaveBeenCalled()
    expect(ref.current).toBe(false)
  })
})
