import { beforeEach, describe, expect, it, vi } from 'vitest'

const callBotRpc = vi.fn(async () => ({ bot: { id: 'bot-1' }, emailed: false }))
vi.mock('@/lib/bot-hosts', () => ({ callBotRpc }))
vi.mock('@/lib/bot-host-refresh', () => ({ beginBotHostUpdate: () => async () => {} }))

const { addBotTeamShare, removeBotTeamShare, resendBotTeamShare } =
  await import('./bot-team-share-rpc')

describe('share dialog calls', () => {
  beforeEach(() => callBotRpc.mockClear())

  it('go to the host share list, never the copy-link share', async () => {
    const bot = { id: 'bot-1', hostId: 'local' as const }
    await addBotTeamShare(bot, 'alice@example.com')
    await removeBotTeamShare(bot, 'share-1')
    await resendBotTeamShare(bot, 'share-2')
    expect(callBotRpc.mock.calls).toEqual([
      [bot, 'bots.teamShares.add', { botId: 'bot-1', emails: ['alice@example.com'] }],
      [bot, 'bots.teamShares.remove', { botId: 'bot-1', shareId: 'share-1' }],
      [bot, 'bots.teamShares.resend', { botId: 'bot-1', shareId: 'share-2' }]
    ])
  })
})
