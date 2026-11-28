import { describe, expect, it } from 'vitest'
import { formatBotDeepLink, parseBotDeepLink } from './bot-deep-link'

const UID = '3f0c9a52-6d1e-4b7a-9c2f-0a4d8e1b7c35'

describe('bot item links', () => {
  it('reads the item a bare bot link names, and keeps it through a second-instance handoff', () => {
    const url = `orca://bot/bot-1?botItem=${UID}`

    expect(parseBotDeepLink(url)).toEqual({ botId: 'bot-1', botItemUid: UID })
    expect(formatBotDeepLink({ botId: 'bot-1', botItemUid: UID })).toBe(url)
    // Conversation links are unchanged: their `item` is a chat transcript entry.
    expect(
      parseBotDeepLink(
        `orca://bot/bot-1?conversation=slack:C1&session=s1&item=entry-1&botItem=${UID}`
      )
    ).toEqual({
      botId: 'bot-1',
      conversation: { source: 'slack', externalId: 'C1' },
      sessionId: 's1',
      itemId: 'entry-1'
    })
    expect(parseBotDeepLink('orca://bot/bot-1?item=entry-1')).toEqual({ botId: 'bot-1' })
  })

  // A host reads an all-digit ref as an item number, which names another item on another computer.
  it.each(['12', '', 'a/b', '..%2Fx', 'a%20b', 'x'.repeat(129)])('refuses botItem=%s', (value) => {
    expect(parseBotDeepLink(`orca://bot/bot-1?botItem=${value}`)).toBeNull()
  })
})
