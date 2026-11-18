import { describe, expect, it } from 'vitest'
import { withBotCancelledWait, type BotCancelledWait } from './bot-cancelled-waits'

describe('withBotCancelledWait', () => {
  it('keeps the first cancelled wait however many come after it', () => {
    let cancelled: BotCancelledWait[] | undefined
    for (let index = 0; index < 500; index++) {
      cancelled = withBotCancelledWait(cancelled, { automationId: `wait-${index}`, at: index })
    }
    expect(cancelled?.[0]).toEqual({ automationId: 'wait-0', at: 0 })
    expect(cancelled).toHaveLength(500)
  })
})
