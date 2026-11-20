// A linked PR's row as fresh as Orca knows it: the host's read, or this window's PR cache when that
// read it later, so a PR merged since the host's read shows merged, not its last CI result. A worker's
// open PR whose newest read is stale asks the PR refresh queue for one more read when its row shows.
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { CACHE_TTL } from '@/store/github/cache/cache-policy'
import type { BotItemGitHubRow } from '../../../../../shared/bots/bot-item-link-rows'

type PrRead = { state: NonNullable<BotItemGitHubRow['state']>; checks: string | null; at: number }

// Each cache the store holds, its newest read per lower-cased PR URL: built once per cache, shared
// by every PR row, so a store write elsewhere costs a row one lookup, not a scan of the cache.
const readsByCache = new WeakMap<AppState['prCache'], ReadonlyMap<string, PrRead>>()

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
        byUrl.set(url, {
          state: data.state,
          checks: data.checksStatus ?? null,
          at: entry.fetchedAt
        })
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
  const enqueueRefresh = useAppStore((state) => state.enqueueGitHubPRRefresh)
  const newer = read !== null && (row.checkedAt === null || read.at > row.checkedAt)
  const live = newer ? { ...row, state: read.state, checks: read.checks, checkedAt: read.at } : row
  const { worktreeId, checkedAt } = live
  const settled = live.state === 'merged' || live.state === 'closed'
  useEffect(() => {
    // Only a read old enough that the PR may have merged since; the queue coalesces and paces it.
    if (worktreeId && !settled && (checkedAt === null || Date.now() - checkedAt >= CACHE_TTL)) {
      enqueueRefresh(worktreeId, 'active', 40)
    }
  }, [worktreeId, settled, checkedAt, enqueueRefresh])
  return live
}
