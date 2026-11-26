import { expect, it } from 'vitest'
import { connectorReplyTurnOutcome } from './journal-connector-reply-turn'

it('silences a whole quiet reply only under the older rule', () => {
  const turn = { outcome: 'success' as const, prose: 'Checked it.\n\nNO_REPLY', bot: true }
  expect(connectorReplyTurnOutcome({ ...turn, silencedWhole: true })).toEqual({ outcome: 'quiet' })
  expect(connectorReplyTurnOutcome(turn)).toEqual({ outcome: 'answered', prose: 'Checked it.' })
})
