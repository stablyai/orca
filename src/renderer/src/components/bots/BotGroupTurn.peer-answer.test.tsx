// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotGroupTurn } from './BotGroupTurn'
import { peerAnswerTurn } from './BotGroupTurn.fixture'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

afterEach(cleanup)

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

it("draws a member's mailed answer to a peer's request on its room turn", () => {
  expect(draw(peerAnswerTurn).getByText(/20160076\.666666668/)).toBeTruthy()
})

it('draws the answer once when the turn already said it', () => {
  const said: Turn = {
    ...peerAnswerTurn,
    answer: 'Result: 20160076.666666668',
    frozenItems: [
      ...peerAnswerTurn.frozenItems!,
      {
        itemId: 'said',
        revision: 1,
        sequence: 3,
        observedAt: 3,
        turnScope: { kind: 'turn', turnItemId: 'turn-answer' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Done. Result: 20160076.666666668' }]
        }
      }
    ]
  }
  expect(draw(said).getAllByText(/20160076\.666666668/)).toHaveLength(1)
})
