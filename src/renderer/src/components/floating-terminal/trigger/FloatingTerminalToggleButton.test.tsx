// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FloatingTerminalToggleButton } from './FloatingTerminalToggleButton'
import { useKeepFloatingTerminalTriggerClear } from './floating-terminal-trigger-keep-clear'
import { FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY } from './floating-terminal-trigger-position'

// Spans the bottom-right of the 1024x768 window, under the button's default spot (left 964, top 660).
const COMMENT_BOX = { left: 600, top: 650, right: 1012, bottom: 756 }

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

it('shows clear of the comment box, follows a drag over it, and saves where it lands', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...COMMENT_BOX, x: 600, y: 650, width: 412, height: 106 }) as DOMRect
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
    const style = (button.closest('.fixed') as HTMLElement).style
    return { left: style.left, top: style.top }
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
