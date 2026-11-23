// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { slackIconFailures } from './bot-slack-icon-failures'
import { publishBotSlackIcon, retryBotSlackIcon } from './use-bot-slack-icons'

const upload = vi.fn<() => Promise<boolean>>()
const resend = vi.fn<() => Promise<boolean>>()
let hostState = 'live'
let wanted = true

vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => [],
  readBotsEnabled: () => true,
  subscribeToBotChanges: () => () => {},
  useBotsEnabled: () => true
}))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBotHostState: () => hostState,
  readLiveBotHostIds: () => ['local']
}))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true }))
vi.mock('@/lib/bot-host-link-read', () => ({ onBotHostCameBack: () => () => {} }))
vi.mock('./bot-slack-icon-raster', () => ({ drawBotSlackIcon: async () => 'cG5n' }))
vi.mock('./bot-slack-icon-rpc', () => ({
  botSlackIconWanted: async () => ({ wanted, current: true }),
  uploadBotSlackIcon: () => upload(),
  resendBotSlackIcon: () => resend()
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

it('keeps the note while the host is away, and resends an icon the host already keeps', async () => {
  upload.mockReset()
  upload.mockRejectedValueOnce(new Error('host timed out'))
  publishBotSlackIcon({ ...bot, id: 'bot-2' })
  const failed = { ...bot, id: 'bot-2' }
  await vi.waitFor(() => expect(slackIconFailures.size).toBe(1))

  // Away: Try again does nothing and the note stays.
  hostState = 'offline'
  retryBotSlackIcon(failed)
  expect(slackIconFailures.size).toBe(1)
  expect(upload).toHaveBeenCalledTimes(1)

  // Back, with the drawing already kept: Try again asks the host to send it on.
  hostState = 'live'
  wanted = false
  resend.mockResolvedValueOnce(true)
  retryBotSlackIcon(failed)
  await vi.waitFor(() => expect(resend).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(slackIconFailures.size).toBe(0))
  expect(upload).toHaveBeenCalledTimes(1)
})
