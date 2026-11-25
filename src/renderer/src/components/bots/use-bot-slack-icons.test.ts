// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { publishBotSlackIcon, withSlackIconPublish } from './use-bot-slack-icons'

const upload = vi.fn<(bot: Bot, look: string) => Promise<boolean>>()
let listed: Bot[] = []

vi.mock('@/lib/bot-catalog', () => ({
  readBotsEnabled: () => true,
  subscribeToBotChanges: () => () => {},
  useBotsEnabled: () => true
}))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBotHostState: () => 'live',
  readBotHostIds: () => [],
  readBots: () => listed,
  readHostBots: () => listed
}))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true }))
vi.mock('@/lib/bot-host-link-read', () => ({ onBotHostCameBack: () => () => {} }))
vi.mock('./bot-outfit-art', () => ({ allowOutfitReadsAgain: () => {} }))
vi.mock('./bot-slack-icon-raster', () => ({ drawBotSlackIcon: async () => 'cG5n' }))
vi.mock('./bot-slack-icon-rpc', () => ({
  botSlackIconWanted: async () => ({ wanted: true, current: true }),
  uploadBotSlackIcon: (bot: Bot, look: string) => upload(bot, look)
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

it('never lets an older save of this window cancel the drawing of a newer look saved elsewhere', async () => {
  upload.mockReset()
  upload.mockResolvedValue(true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  const older = { ...fields, id: 'bot-2', avatar: 'mascot:A1', updatedAt: 1 } as unknown as Bot
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  const newer = { ...fields, id: 'bot-2', avatar: 'mascot:G1', updatedAt: 2 } as unknown as Bot
  // A phone's save of G1 is listed (and asked for) while this window's save of A1 is still answering.
  listed = [newer]
  publishBotSlackIcon(newer)
  await withSlackIconPublish(async () => older, older.hostId)({})
  await vi.waitFor(() => expect(upload).toHaveBeenCalled())
  expect(upload.mock.calls.map(([bot]) => bot.avatar)).toEqual(['mascot:G1'])
  listed = []
})
