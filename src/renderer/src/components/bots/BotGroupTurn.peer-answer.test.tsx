// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotGroupTurn } from './BotGroupTurn'
import { peerAnswerTurn } from './BotGroupTurn.fixture'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

afterEach(cleanup)

it("draws a member's mailed answer to a peer's request on its room turn", () => {
  const view = render(
    <TooltipProvider>
      <BotGroupTurn
        hostId="local"
        turn={peerAnswerTurn}
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
  expect(view.getByText(/20160076\.666666668/)).toBeTruthy()
})
