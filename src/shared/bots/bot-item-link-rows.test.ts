import { expect, it } from 'vitest'
import type { BotItemLinkView, BotItemPullRequest } from './bot-items'
import { botItemLinkRows } from './bot-item-link-rows'

const PR: BotItemPullRequest = {
  shown: true,
  ref: 'acme/app#9',
  number: 9,
  url: 'https://github.com/acme/app/pull/9',
  state: 'open',
  checks: null,
  review: null,
  checkedAt: 1
}

it('lists one PR however it was linked: by its worker, as pr: and as a URL', () => {
  const links: BotItemLinkView[] = [
    { kind: 'url', ref: 'https://github.com/acme/app/pull/9/files' },
    { kind: 'pr', ref: 'Acme/App#9', pr: null },
    {
      kind: 'dispatch',
      ref: 'ctx_1',
      latest: null,
      title: 'Worker',
      state: 'completed',
      host: null,
      startedAt: 1,
      settledAt: 2,
      report: null,
      pr: PR
    }
  ]
  expect(botItemLinkRows(links).map((row) => row.kind)).toEqual(['worker', 'github'])
})

it('lists a PR linked by URL and as pr: once when the cache has not read it', () => {
  const rows = botItemLinkRows([
    { kind: 'url', ref: 'https://github.com/acme/app/pull/9' },
    { kind: 'pr', ref: 'acme/app#9', pr: null }
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'github',
    url: 'https://github.com/acme/app/pull/9',
    title: null
  })
})
