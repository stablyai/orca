import { describe, expect, it } from 'vitest'
import type { ExternalConversationLink } from '../connectors/external-conversation-link'
import { botOwnsChatSession } from './bot-chat-identity'

const bot = { id: 'atlas', chatSessionId: 'home' }
const link: ExternalConversationLink = {
  source: 'slack',
  externalId: 'thread',
  sessionId: 'external',
  agent: 'codex',
  paneKey: 'agent-session:external',
  bot: { kind: 'bot', botId: 'atlas' },
  createdAt: 1
}

describe('bot chat identity', () => {
  it('identifies Home by its exact session, never other sessions in the same folder', () => {
    expect(botOwnsChatSession(bot, 'home')).toBe(true)
    for (const session of [null, 'ordinary', 'worker']) {
      expect(botOwnsChatSession(bot, session)).toBe(false)
    }
    expect(botOwnsChatSession({ id: bot.id }, 'home')).toBe(false)
  })
  it('requires both external session and bot ownership, retaining legacy fallback', () => {
    expect(botOwnsChatSession(bot, 'external', [link])).toBe(true)
    expect(botOwnsChatSession(bot, 'ordinary', [link])).toBe(false)
    expect(botOwnsChatSession({ ...bot, id: 'deleted' }, 'external', [link])).toBe(false)
    expect(botOwnsChatSession(bot, 'external', [{ ...link, bot: undefined }])).toBe(false)
  })
})
