import { describe, expect, it } from 'vitest'
import { restartContinuationHistory } from './native-chat-restart-continuation-outcomes'

describe('restart continuation history', () => {
  it('never turns an unconfirmed or missing outcome into continued', () => {
    expect(
      restartContinuationHistory(
        ['pending', 'unknown', 'ok', 'omitted'],
        [
          { sessionId: 'pending', outcome: 'pending' },
          { sessionId: 'unknown', outcome: 'unknown' },
          { sessionId: 'ok', outcome: 'continued' }
        ]
      )
    ).toEqual([
      { sessionId: 'pending', outcome: 'pending' },
      { sessionId: 'unknown', outcome: 'unknown' },
      { sessionId: 'ok', outcome: 'continued' },
      { sessionId: 'omitted', outcome: 'unknown' }
    ])
  })
})
