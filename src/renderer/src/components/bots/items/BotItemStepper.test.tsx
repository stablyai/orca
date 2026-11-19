// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FloatingTerminalToggleButton } from '../../floating-terminal/trigger/FloatingTerminalToggleButton'
import { BotItemNavRow } from './BotItemStepper'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

// Every box measures as the arrows' row at the bottom-right of the 1024x768 window, under the button's default
// spot (left 964, top 660), filling its pane so the button can only go above it.
it("keeps the floating terminal button off the arrows' row under a question's card", () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(600, 650, 412, 106)
  )
  render(
    <TooltipProvider>
      <BotItemNavRow nav={<span>arrows</span>} plain />
      <FloatingTerminalToggleButton open={false} onToggle={() => {}} />
    </TooltipProvider>
  )
  const placed = screen.getByRole('button').closest<HTMLElement>('.fixed')
  expect({ left: placed?.style.left, top: placed?.style.top }).toEqual({
    left: '964px',
    top: '606px'
  })
})
