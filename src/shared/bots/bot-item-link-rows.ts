// An item's links as the rows its Links section draws, in order: workers, PRs and issues, other links,
// files. A worker's PR is listed once with the PRs, beside any link to the same PR.
import type { BotChatTreeWorker } from './bot-chat-tree'
import type {
  BotItemIssue,
  BotItemLinkView,
  BotItemPullRequest,
  BotItemWorkerState
} from './bot-items'
import { botItemLinksOnePerChain, botItemPrRefOfUrl, botItemPrUrl } from './bot-items'
import {
  botItemFileName,
  botItemGitHubRefOfUrl,
  botItemHomeRepo,
  botItemLinearKeyOfUrl,
  botItemUrlHost
} from './bot-item-link-names'

export type BotItemLinkBrand = 'github' | 'linear' | 'slack'

export type BotItemLinkRow =
  | { kind: 'worker'; key: string; link: Extract<BotItemLinkView, { kind: 'dispatch' }> }
  | BotItemGitHubRow
  | { kind: 'server-pr'; key: string }
  | {
      kind: 'web'
      key: string
      url: string
      brand: BotItemLinkBrand | null
      /** Host and path, or a Linear issue's identifier. */
      title: string
      /** The hover tooltip: the domain. */
      tip: string
      /** A Linear issue's identifier: listed with the PRs and issues, titled when Orca has read it. */
      linear: string | null
    }
  | { kind: 'file'; key: string; path: string; name: string }
  /** A wait or schedule that will wake the agent for the item; `active` while it exists and is on. */
  | { kind: 'automation'; key: string; name: string | null; active: boolean }

/** A GitHub PR or issue on one line; `title` and `state` are null until the host's cache has read it. */
export type BotItemGitHubRow = {
  kind: 'github'
  key: string
  type: 'pr' | 'issue'
  url: string
  repo: string
  number: number
  title: string | null
  state: Extract<BotItemPullRequest, { shown: true }>['state'] | null
  checks: string | null
  /** When the host's cache read `state` and `checks`; null for a link the cache has not read. */
  checkedAt: number | null
  /** A worker's PR: the worktree whose PR read refreshes it. */
  worktreeId: string | null
  /** The repo differs from the item's other GitHub links. */
  showRepo: boolean
}

const BRAND_HOSTS: readonly [RegExp, BotItemLinkBrand][] = [
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)linear\.app$/, 'linear'],
  [/(^|\.)slack\.com$/, 'slack']
]

function githubRow(url: string, issue: BotItemIssue | undefined): BotItemGitHubRow | null {
  const ref = botItemGitHubRefOfUrl(url)
  if (!ref) {
    return null
  }
  const { type, repo, number } = ref
  return {
    kind: 'github',
    key: `url:${url}`,
    type,
    url,
    repo,
    number,
    title: (type === 'issue' && issue?.title) || null,
    state: type === 'issue' ? (issue?.state ?? null) : null,
    checks: null,
    checkedAt: null,
    worktreeId: null,
    showRepo: false
  }
}

function prRow(pr: Extract<BotItemPullRequest, { shown: true }>): BotItemGitHubRow {
  return {
    kind: 'github',
    key: `pr:${prKey(pr.ref)}`,
    type: 'pr',
    url: pr.url,
    repo: pr.ref.split('#')[0] ?? pr.ref,
    number: pr.number,
    title: pr.title || null,
    state: pr.state,
    checks: pr.checks,
    checkedAt: pr.checkedAt,
    worktreeId: pr.worktreeId ?? null,
    showRepo: false
  }
}

function webRow(url: string): Extract<BotItemLinkRow, { kind: 'web' }> {
  const host = botItemUrlHost(url)
  const brand = BRAND_HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? null
  const base = { kind: 'web' as const, key: `url:${url}`, url, brand, linear: null }
  const linear = brand === 'linear' ? botItemLinearKeyOfUrl(url) : null
  if (linear) {
    return { ...base, title: linear, tip: host, linear }
  }
  const title = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return { ...base, title, tip: host || url }
}

function fileRow(path: string): Extract<BotItemLinkRow, { kind: 'file' }> {
  return { kind: 'file', key: `file:${path}`, path, name: botItemFileName(path) }
}

function group(row: BotItemLinkRow): number {
  switch (row.kind) {
    case 'worker':
      return 0
    case 'github':
    case 'server-pr':
      return 1
    case 'web':
      return row.linear ? 2 : 3
    case 'file':
      return 4
    case 'automation':
      return 5
  }
}

/** One PR however it was linked: by URL, `pr:` ref or a worker's PR. GitHub names are case-blind. */
function prKey(ref: string): string {
  return ref.trim().toLowerCase()
}

/** Rows a Links list draws at first and adds per Show more: an item holds up to 1,000 links. */
export const BOT_ITEM_LINK_ROWS = 50

/** The rows a Links list draws with `shown` of them open. A list that fits one page keeps the grouped
 *  order; a longer one runs newest first (by its newest link), so live workers and recent PRs need no
 *  Show more and each Show more adds older rows below. `more`: the rows the next Show more adds. */
export function botItemLinkPage(
  links: readonly BotItemLinkView[],
  shown: number
): { rows: BotItemLinkRow[]; more: number } {
  const { rows, newestAt } = linkRowsWithRecency(links)
  if (rows.length <= BOT_ITEM_LINK_ROWS) {
    return { rows, more: 0 }
  }
  const at = (row: BotItemLinkRow) => newestAt.get(row.key) ?? -1
  // Stable: a worker and its PR, from one link, keep the grouped order.
  const newest = rows.toSorted((a, b) => at(b) - at(a))
  return {
    rows: newest.slice(0, shown),
    more: Math.min(Math.max(rows.length - shown, 0), BOT_ITEM_LINK_ROWS)
  }
}

export function botItemLinkRows(links: readonly BotItemLinkView[]): BotItemLinkRow[] {
  return linkRowsWithRecency(links).rows
}

/** The rows, and by row key the newest link each one stands for (its index in `links`). */
function linkRowsWithRecency(links: readonly BotItemLinkView[]): {
  rows: BotItemLinkRow[]
  newestAt: Map<string, number>
} {
  const rows: BotItemLinkRow[] = []
  const newestAt = new Map<string, number>()
  const seen = (map: Map<string, number>, key: string, index: number): void => {
    map.set(key, Math.max(map.get(key) ?? -1, index))
  }
  const indexOf = new Map(links.map((link, index) => [link, index]))
  const prs = new Map<string, Extract<BotItemPullRequest, { shown: true }>>()
  const prAt = new Map<string, number>()
  const unread = new Map<string, string>()
  let serverPr = false
  let serverPrAt = -1
  // A worker's row, and its PR's, stand for every step of its chain, read before the chain collapses.
  const chainAt = new Map<string, number>()
  links.forEach((link, index) => {
    if (link.kind !== 'dispatch') {
      return
    }
    seen(chainAt, link.latest ?? link.ref, index)
    if (link.pr?.shown) {
      seen(prAt, prKey(botItemPrRefOfUrl(link.pr.url) ?? link.pr.ref), index)
    } else if (link.pr) {
      serverPrAt = Math.max(serverPrAt, index)
    }
  })
  const addPr = (pr: BotItemPullRequest, index: number): void => {
    if (!pr.shown) {
      serverPr = true
      serverPrAt = Math.max(serverPrAt, index)
      return
    }
    const key = prKey(botItemPrRefOfUrl(pr.url) ?? pr.ref)
    seen(prAt, key, index)
    const known = prs.get(key)
    // A worker's read carries the workspace the page reports for refresh; keep it over a bare link.
    if (!known || (!known.worktreeId && pr.worktreeId)) {
      prs.set(key, pr)
    }
  }
  const addUnread = (ref: string, index: number): void => {
    seen(prAt, prKey(ref), index)
    if (!unread.has(prKey(ref))) {
      unread.set(prKey(ref), ref)
    }
  }
  const push = (row: BotItemLinkRow, index: number): void => {
    rows.push(row)
    seen(newestAt, row.key, index)
  }
  for (const link of botItemLinksOnePerChain(links)) {
    const index = indexOf.get(link) ?? -1
    switch (link.kind) {
      case 'dispatch':
        push(
          { kind: 'worker', key: `dispatch:${link.ref}`, link },
          chainAt.get(link.latest ?? link.ref) ?? index
        )
        if (link.pr) {
          addPr(link.pr, index)
        }
        break
      case 'pr':
        if (link.pr) {
          addPr(link.pr, index)
        } else {
          addUnread(link.ref, index)
        }
        break
      case 'url': {
        const pr = botItemPrRefOfUrl(link.ref)
        if (pr) {
          addUnread(pr, index)
        } else {
          push(githubRow(link.ref, link.issue) ?? webRow(link.ref), index)
        }
        break
      }
      case 'file':
        push(fileRow(link.ref), index)
        break
      case 'automation':
        push(
          {
            kind: 'automation',
            key: `automation:${link.ref}`,
            name: link.name,
            active: link.active
          },
          index
        )
        break
    }
  }
  for (const [key, pr] of prs) {
    push(prRow(pr), prAt.get(key) ?? -1)
  }
  for (const [key, ref] of unread) {
    // A PR the cache has not read yet: a link to it, unless another link already shows its state.
    if (!prs.has(key)) {
      const url = botItemPrUrl(ref)
      const row = url ? githubRow(url, undefined) : null
      push(row ? { ...row, key: `pr:${key}` } : webRow(ref), prAt.get(key) ?? -1)
    }
  }
  if (serverPr) {
    push({ kind: 'server-pr', key: 'server-pr' }, serverPrAt)
  }
  markOtherRepos(rows)
  // Sort is stable: each group keeps the item's own order.
  return { rows: rows.sort((a, b) => group(a) - group(b)), newestAt }
}

/** The item's repo is the one most of its GitHub links share; only links elsewhere name theirs. */
function markOtherRepos(rows: BotItemLinkRow[]): void {
  const github = rows.flatMap((row) => (row.kind === 'github' ? [row] : []))
  const home = botItemHomeRepo(github.map((row) => row.repo))
  for (const row of github) {
    row.showRepo = row.repo.toLowerCase() !== home
  }
}

const WORKER_STATES: Record<BotItemWorkerState, BotChatTreeWorker['state']> = {
  working: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'failed',
  unknown: 'unreachable',
  missing: 'done'
}

/** A linked worker as the chats tree draws its workers. */
export function botItemWorkerRow(
  link: Extract<BotItemLinkView, { kind: 'dispatch' }>
): BotChatTreeWorker {
  return {
    key: link.ref,
    title: link.title ?? link.ref,
    state: WORKER_STATES[link.state],
    startedAt: link.startedAt ?? 0,
    ...(link.settledAt !== null ? { settledAt: link.settledAt } : {}),
    dispatchId: link.latest ?? link.ref,
    ...(link.neverStarted ? { neverStarted: true as const } : {}),
    ...(link.host ? { hostId: link.host } : {}),
    ...(link.report ? { summary: link.report.subject } : {})
  }
}
