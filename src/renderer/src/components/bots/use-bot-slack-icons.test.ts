// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { publishBotSlackIcon, withSlackIconPublish } from './use-bot-slack-icons'

const upload = vi.fn<() => Promise<boolean>>()

vi.mock('@/lib/bot-catalog', () => ({
  readBotsEnabled: () => true,
  subscribeToBotChanges: () => () => {},
  useBotsEnabled: () => true
}))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBotHostState: () => 'live',
  readBotHostIds: () => [],
  readHostBots: () => []
}))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true }))
vi.mock('@/lib/bot-host-link-read', () => ({ onBotHostCameBack: () => () => {} }))
vi.mock('./bot-slack-icon-raster', () => ({ drawBotSlackIcon: async () => 'cG5n' }))
vi.mock('./bot-slack-icon-rpc', () => ({
  botSlackIconWanted: async () => ({ wanted: true, current: true }),
  uploadBotSlackIcon: () => upload()
}))

const fields = {
  id: 'bot-1',
  hostId: 'local',
  avatar: 'mascot:A1',
  avatarColor: '#1f2126',
  avatarOutfit: null,
  slack: { appId: 'A1', teamId: 'T1' },
  github: null
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the icon path reads only these fields of a bot.
const bot = fields as unknown as Bot

it('retries a failed icon only on a real step, never on a timer', async () => {
  vi.useFakeTimers()
  upload.mockRejectedValueOnce(new Error('host timed out'))
  publishBotSlackIcon(bot)
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  // Nothing is scheduled, and asking again with the same record does not try it again.
  expect(vi.getTimerCount()).toBe(0)
  publishBotSlackIcon(bot)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(upload).toHaveBeenCalledTimes(1)

  // A real step (the owner saves the bot's look) tries it again.
  upload.mockResolvedValueOnce(true)
  await withSlackIconPublish(async () => bot, bot.hostId)({})
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})
