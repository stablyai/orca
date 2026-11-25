// A person's or chats' own read failing says so as the bot's read does: failed with Retry before it
// lands, the stale line after; the bot's read standing for an unscoped list.
import { describe, expect, it, vi } from 'vitest'
import type { BotItemsRead } from './use-bot-items'
import { botItemsShownReadState } from './use-bot-items-shown-list'

const READ = { items: [], counts: {}, seenEventId: 'e0' } satisfies BotItemsRead
const bot = { state: 'ready' as const, refreshFailed: false, retry: vi.fn() }

describe('the read the Items list shows', () => {
  it("fails a person's first read with its own Retry, though the bot's read stands", () => {
    const retry = vi.fn()
    const shown = botItemsShownReadState(
      { scoped: true, read: null, chatRead: { failed: true, retry } },
      bot
    )
    expect(shown).toMatchObject({ state: 'failed', refreshFailed: false })
    shown.retry()
    expect(retry).toHaveBeenCalled()
    expect(bot.retry).not.toHaveBeenCalled()
  })

  it("says a person's failed re-read over its last list, and loads until the first lands", () => {
    const chatRead = { failed: true, retry: vi.fn() }
    expect(botItemsShownReadState({ scoped: true, read: READ, chatRead }, bot)).toMatchObject({
      state: 'ready',
      refreshFailed: true
    })
    expect(
      botItemsShownReadState(
        { scoped: true, read: null, chatRead: { ...chatRead, failed: false } },
        bot
      ).state
    ).toBe('loading')
  })

  it("is the bot's own read for an unscoped list", () => {
    const failedBot = { state: 'failed' as const, refreshFailed: false, retry: vi.fn() }
    expect(
      botItemsShownReadState(
        { scoped: false, read: null, chatRead: { failed: false, retry: vi.fn() } },
        failedBot
      )
    ).toBe(failedBot)
  })
})
