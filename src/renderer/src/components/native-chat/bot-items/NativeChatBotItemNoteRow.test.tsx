// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BotItemNoteView } from '../../../../../shared/bots/bot-item-note'
import { NativeChatBotItemNoteRow } from './NativeChatBotItemNoteRow'

const added = (uid: string, title: string) =>
  ({ uid, number: 1, title, status: 'planned', event: 'made' }) as const

function note(...entries: ReturnType<typeof added>[]): BotItemNoteView {
  return { noteId: 'n1', by: 'bot', entries }
}

describe('a bot item line in chat', () => {
  it('keeps its line, and the chip in it, when another item joins it mid-turn', () => {
    const { rerender } = render(
      <TooltipProvider>
        <NativeChatBotItemNoteRow note={note(added('a', 'Share dialog'))} />
      </TooltipProvider>
    )
    const chip = screen.getByRole('button', { name: 'Share dialog, Planned' })

    rerender(
      <TooltipProvider>
        <NativeChatBotItemNoteRow
          note={note(added('a', 'Share dialog'), added('b', 'Release notes'))}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: 'Release notes, Planned' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share dialog, Planned' })).toBe(chip)
  })
})
