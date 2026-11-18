import { describe, expect, it } from 'vitest'
import {
  formatBotAccessRequestDeepLink,
  formatBotDeepLink,
  parseBotAccessRequestDeepLink,
  parseBotDeepLink
} from './bot-deep-link'

describe('parseBotDeepLink', () => {
  it('reads the bot id and the Slack conversation', () => {
    expect(
      parseBotDeepLink('orca://bot/bot_1?conversation=slack%3AT1%3AC1%3A1700000000.000100')
    ).toEqual({
      botId: 'bot_1',
      conversation: { source: 'slack', externalId: 'T1:C1:1700000000.000100' }
    })
  })

  it('reads a bare link as the bot alone, which opens its Home', () => {
    expect(parseBotDeepLink('orca://bot/bot_1')).toEqual({ botId: 'bot_1' })
    expect(parseBotDeepLink('orca://bot/bot_1/')).toEqual({ botId: 'bot_1' })
    expect(parseBotDeepLink(formatBotDeepLink({ botId: 'bot-2' }))).toEqual({ botId: 'bot-2' })
  })

  it('accepts the trailing slash some launchers append', () => {
    expect(parseBotDeepLink('orca://bot/bot_1/?conversation=slack:T1')?.botId).toBe('bot_1')
  })

  it.each([
    'orca://bot/%2e%2e?conversation=slack:T1',
    'orca://bot/a%2Fb?conversation=slack:T1',
    'orca://bot/a/b?conversation=slack:T1',
    'orca://bot/?conversation=slack:T1',
    'orca://bot/bot_1?conversation=T1',
    'orca://bot/bot_1?conversation=email:T1',
    'orca://bot/bot_1?conversation=slack:',
    'orca://bot/bot_1?conversation=slack%3AT1%0A',
    'orca://skills/share/abc',
    'https://app.orca.dev/bot/bot_1?conversation=slack:T1',
    'not a url'
  ])('rejects %s', (value) => {
    expect(parseBotDeepLink(value)).toBeNull()
  })

  it('round-trips through the link it formats', () => {
    const link = {
      botId: 'bot-2',
      conversation: { source: 'slack' as const, externalId: 'T1:C1:1700.1&x=#y' }
    }
    expect(parseBotDeepLink(formatBotDeepLink(link))).toEqual(link)
  })
})

describe('parseBotAccessRequestDeepLink', () => {
  const token = 'a'.repeat(43)

  it("reads the token from the owner's Review in Orca, and never as a bot named access-request", () => {
    const url = `orca://bot/access-request?t=${token}`
    expect(parseBotAccessRequestDeepLink(url)).toEqual({ token })
    expect(parseBotDeepLink(url)).toBeNull()
    expect(parseBotAccessRequestDeepLink(formatBotAccessRequestDeepLink({ token }))).toEqual({
      token
    })
  })

  it('refuses a malformed token or another place', () => {
    expect(parseBotAccessRequestDeepLink('orca://bot/access-request?t=short')).toBeNull()
    expect(parseBotAccessRequestDeepLink(`orca://bot/access-request`)).toBeNull()
    expect(parseBotAccessRequestDeepLink(`orca://bot/other?t=${token}`)).toBeNull()
    expect(parseBotAccessRequestDeepLink(`https://bot/access-request?t=${token}`)).toBeNull()
  })
})
