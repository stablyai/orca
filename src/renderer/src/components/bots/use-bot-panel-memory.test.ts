import { describe, expect, it } from 'vitest'
import { botPanelStep } from './use-bot-panel-memory'

const closedB1 = new Set(['b1'])

describe('botPanelStep', () => {
  it("applies a bot's remembered closed panel when its page opens", () => {
    expect(
      botPanelStep(
        { botId: null, open: true, routeRequestId: 1 },
        { botId: 'b1', open: true, routeRequestId: 1 },
        null,
        closedB1
      )
    ).toEqual({ open: false, beforeBots: true })
  })

  it('keeps an Up next reveal open when it opens a bot whose panel was closed', () => {
    expect(
      botPanelStep(
        { botId: null, open: false, routeRequestId: 1 },
        { botId: 'b1', open: true, routeRequestId: 2 },
        null,
        closedB1
      )
    ).toEqual({ beforeBots: false })
  })

  it('does not remember a reveal as the owner opening the panel', () => {
    expect(
      botPanelStep(
        { botId: 'b1', open: false, routeRequestId: 1 },
        { botId: 'b1', open: true, routeRequestId: 2 },
        true,
        closedB1
      )
    ).toEqual({ beforeBots: true })
  })

  it('leaves an explicit request alone when leaving bots', () => {
    expect(
      botPanelStep(
        { botId: 'b1', open: false, routeRequestId: 1 },
        { botId: null, open: true, routeRequestId: 2 },
        false,
        closedB1
      )
    ).toEqual({ beforeBots: null })
  })
})
