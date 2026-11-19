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

it('lists each pull request once across worker, pr: and URL links, even without metadata', () => {
  const links: BotItemLinkView[] = [
    { kind: 'url', ref: 'https://github.com/acme/app/pull/9/files' },
    { kind: 'pr', ref: 'Acme/App#9', pr: null },
    { kind: 'url', ref: 'https://github.com/acme/app/pull/10' },
    { kind: 'pr', ref: 'acme/app#10', pr: null },
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
  const rows = botItemLinkRows(links)
  expect(rows.map((row) => row.kind)).toEqual(['worker', 'github', 'github'])
  expect(rows[2]).toMatchObject({
    kind: 'github',
    url: 'https://github.com/acme/app/pull/10',
    title: null
  })
})

const step = (ref: string, latest: string | null): BotItemLinkView => ({
  kind: 'dispatch',
  ref,
  latest,
  title: 'Run one more e2e',
  state: 'working',
  host: null,
  startedAt: 5,
  settledAt: null,
  report: null,
  pr: null
})

it("lists one worker for every linked step of its follow-up chain, the chain's newest included", () => {
  const rows = botItemLinkRows([
    step('ctx_1', 'ctx_9'),
    step('ctx_3', 'ctx_9'),
    step('ctx_9', null),
    step('ctx_5', 'ctx_9'),
    step('ctx_other', null)
  ])
  expect(rows.map((row) => row.key)).toEqual(['dispatch:ctx_1', 'dispatch:ctx_other'])
})
