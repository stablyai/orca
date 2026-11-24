// A linked PR's row as fresh as Orca knows it: the host's read, or this window's PR cache when that
// read it later, so a PR merged since the host's read shows merged, not its last CI result. While the
// item page shows, each PR's workspace counts as a visible sidebar row, so the shared PR refresh
// queue keeps it fresh at the sidebar's cadence and stops when the page closes.
import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type {
  BotItemGitHubRow,
  BotItemLinkRow
} from '../../../../../shared/bots/bot-item-link-rows'

type PrRead = {
  title: string | null
  state: NonNullable<BotItemGitHubRow['state']>
  checks: string | null
  at: number
}
type PrCacheEntry = NonNullable<AppState['prCache'][string]>

// Each cache the store holds, its newest read per lower-cased PR URL: built once per cache, shared
// by every PR row, so a store write elsewhere costs a row one lookup, not a scan of the cache.
const readsByCache = new WeakMap<AppState['prCache'], ReadonlyMap<string, PrRead>>()
// One read per cache entry, so a write to another PR hands a row the same object and skips its render.
const readsByEntry = new WeakMap<PrCacheEntry, PrRead>()

function entryRead(entry: PrCacheEntry, data: NonNullable<PrCacheEntry['data']>): PrRead {
  let read = readsByEntry.get(entry)
  if (!read) {
    read = {
      title: data.title || null,
      state: data.state,
      checks: data.checksStatus ?? null,
      at: entry.fetchedAt
    }
    readsByEntry.set(entry, read)
  }
  return read
}

function prReads(cache: AppState['prCache']): ReadonlyMap<string, PrRead> {
  let reads = readsByCache.get(cache)
  if (!reads) {
    const byUrl = new Map<string, PrRead>()
    for (const entry of Object.values(cache)) {
      const data = entry?.data
      if (!data?.url) {
        continue
      }
      const url = data.url.toLowerCase()
      const known = byUrl.get(url)
      if (!known || entry.fetchedAt > known.at) {
        byUrl.set(url, entryRead(entry, data))
      }
    }
    reads = byUrl
    readsByCache.set(cache, reads)
  }
  return reads
}

export function useBotItemLivePr(row: BotItemGitHubRow): BotItemGitHubRow {
  const read = useAppStore((state) =>
    row.type === 'pr' ? (prReads(state.prCache).get(row.url.toLowerCase()) ?? null) : null
  )
  const newer = read !== null && (row.checkedAt === null || read.at > row.checkedAt)
  return newer
    ? {
        ...row,
        title: read.title ?? row.title,
        state: read.state,
        checks: read.checks,
        checkedAt: read.at
      }
    : row
}

/** Reports the workspaces behind the page's PR rows as visible while it is mounted. */
export function useBotItemPrWorkspacesVisible(rows: readonly BotItemLinkRow[]): void {
  const publish = useAppStore((state) => state.setVisibleItemPageReviewWorktreeIds)
  const key = useMemo(
    () =>
      [
        ...new Set(
          rows.flatMap((row) =>
            row.kind === 'github' && row.type === 'pr' && row.worktreeId ? [row.worktreeId] : []
          )
        )
      ].join('\n'),
    [rows]
  )
  useEffect(() => {
    publish(key ? key.split('\n') : [])
  }, [key, publish])
  useEffect(() => () => publish([]), [publish])
}
