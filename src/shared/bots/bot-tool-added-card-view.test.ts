import { describe, expect, it } from 'vitest'
import { BOT_TOOL_ADDED_CARD_COPY, botToolAddedCardView } from './bot-tool-added-card-view'

const say = (id: keyof typeof BOT_TOOL_ADDED_CARD_COPY) => BOT_TOOL_ADDED_CARD_COPY[id]

describe('botToolAddedCardView', () => {
  it('reads as added with its subtitle and sign-in line until the host says otherwise', () => {
    expect(botToolAddedCardView(null, 'metrics-mcp', 'Needs sign-in', say)).toEqual({
      lead: 'Added',
      after: ['metrics-mcp', 'Needs sign-in'],
      present: false
    })
    expect(botToolAddedCardView(true, 'metrics-mcp', null, say)).toEqual({
      lead: 'Added',
      after: ['metrics-mcp'],
      present: true
    })
  })

  it('reads as removed with nothing after the name once the bot no longer has it', () => {
    expect(botToolAddedCardView(false, 'metrics-mcp', 'Needs sign-in', say)).toEqual({
      lead: 'Removed',
      after: [],
      present: false
    })
  })
})
