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

it('groups link types and lists each pull request only once', () => {
  const links: BotItemLinkView[] = [
    { kind: 'file', ref: 'notes/mock.html' },
    { kind: 'url', ref: 'https://example.com/docs/a' },
    { kind: 'url', ref: 'https://linear.app/acme/issue/eng-12/fix' },
    { kind: 'url', ref: 'https://github.com/acme/app/issues/7' },
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
  expect(rows).toMatchObject([
    { kind: 'worker' },
    { kind: 'github', type: 'issue', number: 7 },
    { kind: 'github', type: 'pr', number: 9 },
    { kind: 'github', type: 'pr', url: 'https://github.com/acme/app/pull/10', title: null },
    { kind: 'web', linear: 'ENG-12' },
    { kind: 'web', url: 'https://example.com/docs/a' },
    { kind: 'file', path: 'notes/mock.html' }
  ])
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
