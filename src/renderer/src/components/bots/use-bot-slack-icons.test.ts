// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { slackIconFailures } from './bot-slack-icon-failures'
import { publishBotSlackIcon, retryBotSlackIcon } from './use-bot-slack-icons'

const upload = vi.fn<() => Promise<boolean>>()

vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => [],
  readBotsEnabled: () => true,
  subscribeToBotChanges: () => () => {},
  useBotsEnabled: () => true
}))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBotHostState: () => 'live',
  readLiveBotHostIds: () => ['local']
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

it('keeps a failed icon as failed with no timer, and sends it on the next step', async () => {
  vi.useFakeTimers()
  upload.mockRejectedValueOnce(new Error('host timed out'))
  publishBotSlackIcon(bot)
  await vi.waitFor(() => expect(slackIconFailures.size).toBe(1))
  // Shown as failed, and nothing is scheduled to try it again on its own.
  expect(vi.getTimerCount()).toBe(0)
  expect(upload).toHaveBeenCalledTimes(1)

  upload.mockResolvedValueOnce(true)
  retryBotSlackIcon(bot)
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(slackIconFailures.size).toBe(0))
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})
