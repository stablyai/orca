// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FloatingTerminalToggleButton } from './FloatingTerminalToggleButton'
import { useKeepFloatingTerminalTriggerClear } from './floating-terminal-trigger-keep-clear'
import { FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY } from './floating-terminal-trigger-position'

function CommentBox(): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  useKeepFloatingTerminalTriggerClear(box)
  return <div ref={box} />
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

// Every box measures as the comment box: the bottom-right of the 1024x768 window, under the button's
// default spot (left 964, top 660), filling its pane so the button can only go above it.
it('shows clear of the comment box, follows a drag over it, and saves where it lands', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(600, 650, 412, 106)
  )
  HTMLElement.prototype.setPointerCapture ??= () => {}
  render(
    <TooltipProvider>
      <CommentBox />
      <FloatingTerminalToggleButton open={false} onToggle={() => {}} />
    </TooltipProvider>
  )
  const button = screen.getByRole('button')
  const spot = (): { left: string; top: string } => {
    const placed = button.closest<HTMLElement>('.fixed')
    return { left: placed?.style.left ?? '', top: placed?.style.top ?? '' }
  }
  expect(spot()).toEqual({ left: '964px', top: '606px' })

  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 980, clientY: 620 })
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 980, clientY: 700 })
  expect(spot()).toEqual({ left: '964px', top: '686px' })

  fireEvent.pointerUp(button, { pointerId: 1, clientX: 980, clientY: 700 })
  expect(spot()).toEqual({ left: '964px', top: '606px' })
  expect(
    JSON.parse(window.localStorage.getItem(FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY) ?? '')
  ).toEqual({ anchorX: 'right', anchorY: 'bottom', offsetX: 24, offsetY: 126 })
})
