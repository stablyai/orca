import { describe, expect, it } from 'vitest'
import { connectorReplyTurnOutcome, connectorReplyWords } from './journal-connector-reply-turn'

const success = (prose: string, addressed: boolean, bot = true) =>
  connectorReplyTurnOutcome({ outcome: 'success', prose, bot, addressed })

describe('a bot’s quiet marker on an answer to a request', () => {
  it('cannot silence the words a bot wrote to someone who addressed it, and only the marker goes', () => {
    expect(success('Fixed both PRs.\n\nNO_REPLY', true)).toEqual({
      outcome: 'answered',
      prose: 'Fixed both PRs.'
    })
    expect(success('Fixed both PRs. **NO_REPLY.**', true)).toEqual({
      outcome: 'answered',
      prose: 'Fixed both PRs.'
    })
  })

  it('still silences a reply that is only the marker', () => {
    expect(success('NO_REPLY', true)).toEqual({ outcome: 'quiet' })
    expect(success('  **NO_REPLY**  ', true)).toEqual({ outcome: 'quiet' })
  })

  it('keeps today’s silence where no one addressed the bot (a thread it follows, mail)', () => {
    expect(success('Nothing for me here.\n\nNO_REPLY', false)).toEqual({ outcome: 'quiet' })
    expect(
      connectorReplyTurnOutcome({ outcome: 'success', prose: 'Done. NO_REPLY', bot: true })
    ).toEqual({ outcome: 'quiet' })
  })

  it('never touches a marker that does not end the reply, or a non-bot’s words', () => {
    expect(success('Say NO_REPLY to skip.\nDone.', true)).toEqual({
      outcome: 'answered',
      prose: 'Say NO_REPLY to skip.\nDone.'
    })
    expect(success('Done. NO_REPLY', false, false)).toEqual({
      outcome: 'answered',
      prose: 'Done. NO_REPLY'
    })
    expect(connectorReplyWords('Done. NO_REPLY', { bot: false, addressed: false })).toBe(
      'Done. NO_REPLY'
    )
  })
})
