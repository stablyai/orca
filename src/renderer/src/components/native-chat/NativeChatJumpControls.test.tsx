// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatJumpControls } from './NativeChatJumpControls'

afterEach(cleanup)

// The reader is usually mid-draft when they reach for these: a press must not take the caret.
it.each(['Jump to latest', 'Jump to top'])(
  'leaves focus in the composer when "%s" is pressed with the pointer',
  async (name) => {
    const onLatest = vi.fn()
    const startFromBeginning = vi.fn()
    render(
      <TooltipProvider>
        <NativeChatJumpControls
          showLatest
          startOutOfView
          historyJump={{ startPending: false, startFromBeginning }}
          onLatest={onLatest}
          transcriptRef={createRef<HTMLElement>()}
        />
        <textarea aria-label="Message" />
      </TooltipProvider>
    )
    const composer = screen.getByRole('textbox', { name: 'Message' })
    composer.focus()

    await userEvent.click(screen.getByRole('button', { name }))

    // Anti-vacuous: the press did act.
    expect(onLatest.mock.calls.length + startFromBeginning.mock.calls.length).toBe(1)
    expect(document.activeElement).toBe(composer)
  }
)

it('hands focus to the transcript when a focused "Jump to top" hides at the start', () => {
  const transcriptRef = createRef<HTMLDivElement>()
  const controls = (startOutOfView: boolean) => (
    <TooltipProvider>
      <div ref={transcriptRef} tabIndex={0} aria-label="Conversation" />
      <NativeChatJumpControls
        showLatest
        startOutOfView={startOutOfView}
        historyJump={{ startPending: false, startFromBeginning: vi.fn() }}
        onLatest={vi.fn()}
        transcriptRef={transcriptRef}
      />
    </TooltipProvider>
  )
  const { rerender } = render(controls(true))
  const top = screen.getByRole('button', { name: 'Jump to top' })
  top.focus()
  // Anti-vacuous: the button held focus before it hid.
  expect(document.activeElement).toBe(top)

  rerender(controls(false))

  expect(top).toHaveAttribute('inert')
  expect(document.activeElement).toBe(transcriptRef.current)
})
