// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'
import { workerStartTurn } from './BotGroupTurn.fixture'

afterEach(() => cleanup())

function renderTurn() {
  return render(
    <TooltipProvider>
      <BotGroupTurn
        hostId="local"
        turn={workerStartTurn}
        files={null}
        roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef: createRef() }}
        roomRows={new BotGroupTranscriptRows()}
        tabId="room-tab"
        isVisible
        onStop={() => {}}
        onReply={() => {}}
        scrollMessageToTop={() => {}}
      />
    </TooltipProvider>
  )
}

// happy-dom has no layout; the overlap came from where these rows sit, so that is what is checked.
it('stacks a worker card and its reply in the transcript column gap, not over each other', () => {
  const view = renderTurn()
  const card = view.getByText('Started worker').closest('[data-native-chat-message-id]')!
  const continuingRow = card.parentElement!
  expect(continuingRow.className).toContain('-mb-3')
  // The row's negative margin is written against the column's flex gap; a margin-stacked parent
  // lets it pull the reply up under the card.
  expect(continuingRow.parentElement!.className).toMatch(/\bflex\b.*\bflex-col\b.*\bgap-5\b/)
  expect(view.getByText(/I've taken the diff-review pair/)).toBeTruthy()
})

it("draws the turn's reply control on the status line, so the line spans the column", () => {
  const view = renderTurn()
  const reply = view.getByRole('button', { name: 'Reply to Triage' })
  const status = view.container.querySelector('[data-native-chat-turn-status]')!
  expect(reply.closest('.border-b')).toBe(status.closest('.border-b'))
  expect(status.className).not.toContain('border-b')
})
