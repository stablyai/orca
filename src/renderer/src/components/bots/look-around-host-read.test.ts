import { afterEach, describe, expect, it, vi } from 'vitest'
import { botRefKey } from '@/lib/bot-hosts'
import type * as BotHosts from '@/lib/bot-hosts'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import { createBotHostRead } from './use-bot-host-read'

const answers = vi.hoisted((): { next: () => unknown } => ({ next: () => ({ value: 1 }) }))
vi.mock('@/lib/bot-hosts', async (original) => ({
  ...(await original<typeof BotHosts>()),
  callBotRpc: vi.fn(async () => answers.next())
}))

afterEach(() => {
  vi.restoreAllMocks()
  answers.next = () => ({ value: 1 })
})

const failing = (code: string) => () => {
  throw Object.assign(new Error(code), { code })
}

describe('a host read', () => {
  it('drops its answer once the host no longer has the method, but keeps it through a blip', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const read = createBotHostRead<number>(
      'bots.lookAround.get',
      (result: { value: number }) => result.value,
      'read failed',
      BOT_WORK_KINDS
    )
    const bot = { hostId: 'local' as const, id: 'b1' }
    const changed = vi.fn()
    read.subscribe(bot, changed)
    read.request(bot)
    await vi.waitFor(() => expect(read.snapshot(botRefKey(bot))).toBe(1))

    answers.next = failing('runtime_unavailable')
    read.request(bot)
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    expect(read.snapshot(botRefKey(bot))).toBe(1)
    expect(read.errorSnapshot(botRefKey(bot))).toMatchObject({ code: 'runtime_unavailable' })

    answers.next = failing('method_not_found')
    read.request(bot)
    await vi.waitFor(() => expect(read.snapshot(botRefKey(bot))).toBeNull())
    expect(read.errorSnapshot(botRefKey(bot))).toMatchObject({ code: 'method_not_found' })
  })
})
