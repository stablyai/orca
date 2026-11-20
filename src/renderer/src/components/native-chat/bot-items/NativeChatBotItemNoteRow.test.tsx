// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatBotItemNoteRow } from './NativeChatBotItemNoteRow'

afterEach(cleanup)

describe("the owner's comment", () => {
  it('puts the item chip above their bubble, so the bubble sizes to their words', () => {
    render(
      <TooltipProvider>
        <NativeChatBotItemNoteRow
          note={{
            noteId: 'n1',
            by: 'owner',
            entries: [
              {
                uid: 'a',
                number: 1,
                title: 'A long item title that would have stretched the bubble to its widest',
                status: 'planned',
                event: 'commented',
                text: 'Same root cause?'
              }
            ]
          }}
        />
      </TooltipProvider>
    )
    const chip = screen.getByRole('button', { name: /A long item title/ })
    // The bubble is the user-message surface around the words.
    const bubble = screen.getByText('Same root cause?').closest('.bg-chat-user-surface')
    expect(bubble).not.toBeNull()
    expect(bubble!.contains(chip)).toBe(false)
    // Chip first, then the message, for screen readers too.
    expect(chip.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
