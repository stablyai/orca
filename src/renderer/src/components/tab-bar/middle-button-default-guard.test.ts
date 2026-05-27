import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { preventMiddleButtonDefault } from './middle-button-default-guard'

function buildEvent(button: number): ReactMouseEvent {
  return {
    button,
    preventDefault: vi.fn()
  } as unknown as ReactMouseEvent
}

describe('preventMiddleButtonDefault', () => {
  it('cancels the default mouseup for middle-button (button === 1)', () => {
    const event = buildEvent(1)
    preventMiddleButtonDefault(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('does not cancel the default mouseup for the left button (button === 0)', () => {
    const event = buildEvent(0)
    preventMiddleButtonDefault(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not cancel the default mouseup for the right button (button === 2)', () => {
    const event = buildEvent(2)
    preventMiddleButtonDefault(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
