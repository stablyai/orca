import { describe, expect, it } from 'vitest'
import type { BotItemLinkView } from './bot-items'
import { BOT_ITEM_LINK_ROWS, botItemLinkPage } from './bot-item-link-rows'

const worker = (i: number): BotItemLinkView => ({
  kind: 'dispatch',
  ref: `ctx_${i}`,
  latest: null,
  title: `Worker ${i}`,
  state: i === 199 ? 'working' : 'completed',
  host: null,
  startedAt: i,
  settledAt: null,
  report: null,
  pr: null
})

describe('a Links list page', () => {
  it('shows the newest links first and pages back to the oldest', () => {
    const links: BotItemLinkView[] = [
      ...Array.from({ length: 200 }, (_, i) => worker(i)),
      { kind: 'url', ref: 'https://example.com/latest' }
    ]
    const first = botItemLinkPage(links, BOT_ITEM_LINK_ROWS)
    const refs = first.rows.map((row) => row.key)
    expect(first.rows).toHaveLength(BOT_ITEM_LINK_ROWS)
    expect(refs.some((key) => key.includes('ctx_199'))).toBe(true)
    expect(refs.some((key) => key.includes('example.com/latest'))).toBe(true)
    expect(refs.some((key) => key.endsWith(':ctx_0'))).toBe(false)
    expect(first.more).toBe(BOT_ITEM_LINK_ROWS)
    const last = botItemLinkPage(links, 250)
    expect(last.rows).toHaveLength(201)
    expect(last.more).toBe(0)
  })
})
