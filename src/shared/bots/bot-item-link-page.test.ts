import { describe, expect, it } from 'vitest'
import type { BotItemLinkView } from './bot-items'
import { BOT_ITEM_LINK_ROWS, botItemLinkPage, botItemLinkRows } from './bot-item-link-rows'
import { botItemLinkPreview, botItemLinksByImportance } from './bot-item-link-order'
import { botItemLinkSearch, botItemLinkSearchIndex } from './bot-item-link-search'

const worker = (
  i: number,
  pr: number | null = null
): Extract<BotItemLinkView, { kind: 'dispatch' }> => ({
  kind: 'dispatch',
  ref: `ctx_${i}`,
  latest: null,
  title: `Worker ${i}`,
  state: 'completed',
  host: null,
  startedAt: i,
  settledAt: null,
  report: null,
  pr:
    pr === null
      ? null
      : {
          shown: true,
          ref: `acme/app#${pr}`,
          number: pr,
          url: `https://github.com/acme/app/pull/${pr}`,
          state: 'open',
          checks: 'success',
          review: null,
          title: `Change ${pr}`,
          checkedAt: 0
        }
})

/** Every row the desktop list draws after opening `pages` pages. */
function opened(links: readonly BotItemLinkView[], pages: number) {
  return botItemLinkPage(links, pages * BOT_ITEM_LINK_ROWS)
}

describe('a Links list page', () => {
  it('runs newest first and adds older rows below, with exact counts', () => {
    const links = Array.from({ length: 120 }, (_, i) => worker(i))
    const first = opened(links, 1)
    expect(first.rows.map((row) => row.key).slice(0, 2)).toEqual([
      'dispatch:ctx_119',
      'dispatch:ctx_118'
    ])
    expect(first.rows).toHaveLength(50)
    expect(first.more).toBe(50)
    const second = opened(links, 2)
    // Show more keeps the first page on top and appends the next older rows.
    expect(second.rows.slice(0, 50)).toEqual(first.rows)
    expect(second.rows.at(-1)?.key).toBe('dispatch:ctx_20')
    expect(second.more).toBe(20)
    const all = opened(links, 3)
    expect(all.rows).toHaveLength(botItemLinkRows(links).length)
    expect(all.more).toBe(0)
  })

  it('builds rows from every link first: a newer bare PR link shows the older worker’s PR state', () => {
    const links: BotItemLinkView[] = [
      worker(0, 42),
      ...Array.from({ length: 60 }, (_, i) => worker(i + 1)),
      { kind: 'url', ref: 'https://github.com/acme/app/pull/42' }
    ]
    const rows = opened(links, 1).rows
    // The PR row is the newest (its bare link was linked last) and carries the worker's read.
    expect(rows[0]).toMatchObject({ kind: 'github', number: 42, title: 'Change 42', state: 'open' })
    expect(rows.filter((row) => row.kind === 'github')).toHaveLength(1)
    // 62 rows: 61 workers and one PR, counted as rows, not links.
    expect(opened(links, 1).more).toBe(botItemLinkRows(links).length - 50)
  })

  it('keeps a list that fits one page in its grouped order', () => {
    const links: BotItemLinkView[] = [worker(0), { kind: 'file', ref: 'a.md' }, worker(1)]
    expect(opened(links, 1)).toEqual({ rows: botItemLinkRows(links), more: 0 })
  })
})

describe('a worker chain on a Links page', () => {
  it('dates its PR by the chain’s newest step, as its worker row is', () => {
    const step = (ref: string): BotItemLinkView => ({ ...worker(0, 7), ref, latest: 'ctx_next' })
    const links: BotItemLinkView[] = [
      step('ctx_first'),
      ...Array.from({ length: 59 }, (_, i): BotItemLinkView => ({ kind: 'file', ref: `f${i}.md` })),
      step('ctx_next')
    ]
    const keys = opened(links, 1).rows.map((row) => row.key)
    expect(keys.slice(0, 2)).toEqual(['dispatch:ctx_first', 'pr:acme/app#7'])
  })
})

it('cuts the mobile preview after five ranked rows and preserves that order in filtered results', () => {
  const links: BotItemLinkView[] = [
    { ...worker(1, 42), title: 'Audit search', state: 'working' },
    { ...worker(2), title: 'Audit files', state: 'failed' },
    { ...worker(3), title: 'Audit history' },
    { ...worker(4, 43), title: 'Check links', state: 'working' },
    { kind: 'file', ref: 'notes/audit.md' },
    { kind: 'url', ref: 'https://example.com/audit' }
  ]
  const rows = botItemLinksByImportance(links)
  expect(botItemLinkPreview(rows).map((row) => row.key)).toEqual([
    'dispatch:ctx_4',
    'dispatch:ctx_1',
    'dispatch:ctx_2',
    'pr:acme/app#43',
    'pr:acme/app#42'
  ])
  expect(botItemLinkPreview(rows.slice(0, 4))).toHaveLength(4)
  expect(rows.slice(5).map((row) => row.kind)).toEqual(['web', 'file', 'worker'])

  const index = botItemLinkSearchIndex(rows)
  const result = botItemLinkSearch(index, ' AUDIT ', 'workers')
  expect(result.counts).toEqual({ all: 5, workers: 3, prs: 0, files: 1 })
  expect(result.rows.map((row) => row.key)).toEqual([
    'dispatch:ctx_1',
    'dispatch:ctx_2',
    'dispatch:ctx_3'
  ])
  expect(botItemLinkSearch(index, 'acme/app #42', 'prs').rows.map((row) => row.key)).toEqual([
    'pr:acme/app#42'
  ])
})
