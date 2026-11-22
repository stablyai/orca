import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import {
  botChatAutoCloseStripText,
  botChatCloseMinutesLeft,
  botChatCloseRowText
} from './bot-chat-auto-close-copy'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy reads only the fallback and its values.
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(values?.[name] ?? '')
  )) as unknown as Translate

const NOW = new Date(2026, 10, 21, 15, 40).getTime()
const TODAY = new Date(2026, 10, 21, 15, 42).getTime()
const YESTERDAY = new Date(2026, 10, 20, 9, 5).getTime()

describe('the strip over the composer', () => {
  it('says when the chat closes and how long is left, in whole minutes', () => {
    const text = botChatAutoCloseStripText(t, { phase: 'counting', closesAt: TODAY }, NOW)
    expect(text).toMatch(
      /^All items here are done or canceled\. History is kept · Closes at .+ \(in 2 min\)$/
    )
    expect(text).toContain('3:42')
    expect(botChatCloseMinutesLeft(TODAY, TODAY - 30_000)).toBe(1)
    expect(botChatCloseMinutesLeft(TODAY, TODAY + 5_000)).toBe(1)
  })

  it('says why closing is paused, and what Keep open did', () => {
    expect(botChatAutoCloseStripText(t, { phase: 'held' }, NOW)).toBe(
      'Closing paused while this chat is open or has an unsent message.'
    )
    expect(botChatAutoCloseStripText(t, { phase: 'kept' }, NOW)).toBe(
      'Kept open until new work finishes.'
    )
  })
})

describe("a chat row's line", () => {
  it('reads Closing soon while counting and Closing paused while held', () => {
    const open = { closed: false }
    expect(
      botChatCloseRowText(t, { ...open, autoClose: { phase: 'counting', closesAt: TODAY } }, NOW)
    ).toBe('Closing soon')
    expect(botChatCloseRowText(t, { ...open, autoClose: { phase: 'held' } }, NOW)).toBe(
      'Closing paused'
    )
    expect(botChatCloseRowText(t, { ...open, autoClose: { phase: 'kept' } }, NOW)).toBeNull()
    expect(botChatCloseRowText(t, open, NOW)).toBeNull()
  })

  it('tells a chat Orca closed, with Reopen, from one closed by hand', () => {
    const byOrca = botChatCloseRowText(
      t,
      { closed: true, closedAt: TODAY, autoClosedAt: TODAY },
      NOW
    )
    expect(byOrca).toMatch(/^Closed by Orca · .*3:42.* · Reopen$/)
    const byHand = botChatCloseRowText(t, { closed: true, closedAt: TODAY }, NOW)
    expect(byHand).toMatch(/^Closed · .*3:42/)
    expect(byHand).not.toContain('Reopen')
  })

  it('names the day, not the time, for a chat closed before today', () => {
    expect(botChatCloseRowText(t, { closed: true, closedAt: YESTERDAY }, NOW)).toMatch(
      /^Closed · .*20/
    )
  })
})
