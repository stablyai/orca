import type { Page } from '@stablyai/playwright-test'

const SYNTHETIC_REPO_PREFIX = 'synthetic-repo-'

export type AccumulatedOrderTrafficStats = {
  publications: number
  rowsRepublished: number
  /** Synchronous setState time only; React commits scheduled after it are not included. */
  syncPublishMs: { total: number; max: number }
}

type OrderFixtureWindow = Window & {
  __accumulatedFixtureOrderTrafficStop?: () => AccumulatedOrderTrafficStats
}

/** Publishes rank-only order changes for seeded repos, one repo per tick, like back-to-back workspace sort saves. */
export async function startAccumulatedOrderTraffic(
  page: Page,
  intervalMs: number
): Promise<number> {
  return page.evaluate(
    ({ interval, repoPrefix }) => {
      const target: OrderFixtureWindow = window
      const store = target.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      const repoIds = Object.keys(store.getState().worktreesByRepo).filter((repoId) =>
        repoId.startsWith(repoPrefix)
      )
      if (repoIds.length === 0) {
        throw new Error('order workload requires the seeded accumulated fixture')
      }
      const stats = { publications: 0, rowsRepublished: 0, syncPublishMs: { total: 0, max: 0 } }
      let tick = 0
      const timer = window.setInterval(() => {
        const repoId = repoIds[tick % repoIds.length]
        tick += 1
        const before = store.getState()
        const startedAt = performance.now()
        store.setState((state) => {
          const rows = state.worktreesByRepo[repoId]
          if (!rows || rows.length < 2) {
            return state
          }
          // Rotate ranks so every row in the repo is republished, as a repo-wide sort save does.
          const next = rows.map((row, index) => ({
            ...row,
            sortOrder: rows[(index + 1) % rows.length].sortOrder
          }))
          stats.rowsRepublished += next.length
          return {
            worktreesByRepo: { ...state.worktreesByRepo, [repoId]: next },
            sortOrderEpoch: state.sortOrderEpoch + 1
          }
        })
        if (store.getState() === before) {
          return
        }
        const elapsed = performance.now() - startedAt
        stats.publications += 1
        stats.syncPublishMs.total += elapsed
        stats.syncPublishMs.max = Math.max(stats.syncPublishMs.max, elapsed)
      }, interval)
      target.__accumulatedFixtureOrderTrafficStop = () => {
        window.clearInterval(timer)
        delete target.__accumulatedFixtureOrderTrafficStop
        return {
          ...stats,
          syncPublishMs: {
            total: Math.round(stats.syncPublishMs.total),
            max: Math.round(stats.syncPublishMs.max)
          }
        }
      }
      return repoIds.length
    },
    { interval: intervalMs, repoPrefix: SYNTHETIC_REPO_PREFIX }
  )
}

export async function stopAccumulatedOrderTraffic(
  page: Page
): Promise<AccumulatedOrderTrafficStats | null> {
  return page.evaluate(() => {
    const target: OrderFixtureWindow = window
    return target.__accumulatedFixtureOrderTrafficStop?.() ?? null
  })
}
