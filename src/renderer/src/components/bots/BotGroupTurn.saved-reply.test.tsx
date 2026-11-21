// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotGroupTurn } from './BotGroupTurn'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

afterEach(cleanup)

// No session rows hold the turn: its member chat's loaded window is newer than it.
const finished: Turn = {
  operationId: 'operation-1',
  botId: 'bot-1',
  botName: 'Forge',
  avatar: null,
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  reply: 'Shipped the fix and opened the PR.'
}

const draw = (turn: Turn) =>
  render(
    <TooltipProvider>
      <BotGroupTurn
        hostId="local"
        turn={turn}
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

it('draws the reply saved when the turn ended when its chat rows are not loaded', () => {
  const view = draw(finished)
  expect(view.getByText('Shipped the fix and opened the PR.')).toBeTruthy()
  expect(view.getByText('Replied')).toBeTruthy()
  expect(view.queryByText('Starting…')).toBeNull()
  expect(view.queryByRole('button', { name: 'Stop Forge' })).toBeNull()
})

it('reads a turn that ended without a reply as ended, not starting', () => {
  const view = draw({ ...finished, reply: null })
  expect(view.getByText('Ended')).toBeTruthy()
  expect(view.queryByText('Starting…')).toBeNull()
  expect(view.queryByRole('button', { name: 'Stop Forge' })).toBeNull()
})

it('still reads a turn with no saved reply and no rows as starting', () => {
  const { reply: _reply, ...running } = finished
  expect(draw(running).getByText('Starting…')).toBeTruthy()
})

it('moves focus from Stop to Reply when the turn ends under it', () => {
  const { reply: _reply, ...running } = finished
  const view = draw(running)
  view.getByRole('button', { name: 'Stop Forge' }).focus()
  view.rerender(
    <TooltipProvider>
      <BotGroupTurn
        hostId="local"
        turn={finished}
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
  expect(view.queryByRole('button', { name: 'Stop Forge' })).toBeNull()
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Reply to Forge' }))
})
