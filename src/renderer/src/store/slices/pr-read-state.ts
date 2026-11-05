import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'

/** What a PR looked like when it was last read: its version plus the activity signals a row carries. */
export type PRReadMark = {
  version: number
  checks: string
  state: GitHubWorkItem['state']
}

/** Marks are per PR per repo, so an unbounded map would grow with every repo the user ever opens. */
export const PR_READ_MARKS_MAX_ENTRIES = 500

/**
 * Stable per-PR key. Rows repeat ids across repos, hosts and providers, so the key carries the
 * producing host and the owner/repo slug alongside the provider id.
 */
export function prReadKey(item: GitHubWorkItem): string {
  const host = item.repoHostId ?? 'local'
  const slug = item.prRepo ? githubRepoIdentityKey(item.prRepo) : item.repoId
  return `${host}:${slug}#${item.id}`
}

/** The row's activity fingerprint; any difference means something happened since the mark. */
export function prActivityMark(item: GitHubWorkItem): PRReadMark {
  const version = Date.parse(item.updatedAt)
  return {
    version: Number.isFinite(version) ? version : 0,
    checks: checkSignal(item),
    state: item.state
  }
}

/**
 * Checks move without touching `updatedAt`, so the row's own summary is the only signal a run
 * finished. Failed runs re-raise; a run settling to success does not, or green CI would raise every
 * row it touched.
 */
function checkSignal(item: GitHubWorkItem): string {
  const summary = item.checksSummary
  if (!summary || summary.state !== 'failure') {
    return ''
  }
  return `failure:${summary.failed}:${summary.cancelled ?? 0}`
}

/** Read iff the stored mark still matches the row; comments, reviews and head pushes each move `updatedAt`. */
export function isPRRead(marks: Record<string, PRReadMark>, item: GitHubWorkItem): boolean {
  const mark = marks[prReadKey(item)]
  if (!mark) {
    return false
  }
  const current = prActivityMark(item)
  return (
    mark.version === current.version &&
    mark.checks === current.checks &&
    mark.state === current.state
  )
}

/** Stamps one row read and keeps the map bounded by dropping the marks nearest their insertion order. */
export function markPRRowsRead(
  marks: Record<string, PRReadMark>,
  items: readonly GitHubWorkItem[]
): Record<string, PRReadMark> {
  if (items.length === 0) {
    return marks
  }
  const next = { ...marks }
  for (const item of items) {
    const key = prReadKey(item)
    delete next[key]
    next[key] = prActivityMark(item)
  }
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - PR_READ_MARKS_MAX_ENTRIES))) {
    delete next[key]
  }
  return next
}

/** The rows with no mark at all; a stale mark is left alone so its activity stays unread. */
export function adoptablePRs(
  marks: Record<string, PRReadMark>,
  items: readonly GitHubWorkItem[]
): readonly GitHubWorkItem[] {
  return items.filter((item) => marks[prReadKey(item)] === undefined)
}

/** Drops one row's mark, so it reads as unread until the user marks it again. */
export function clearPRRowsRead(
  marks: Record<string, PRReadMark>,
  items: readonly GitHubWorkItem[]
): Record<string, PRReadMark> {
  const keys = items.map(prReadKey).filter((key) => marks[key] !== undefined)
  if (keys.length === 0) {
    return marks
  }
  const next = { ...marks }
  for (const key of keys) {
    delete next[key]
  }
  return next
}
