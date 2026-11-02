// @vitest-environment happy-dom

/**
 * The same goldens with ORCA_SIDEBAR_INPUTS=main, where Recent and Smart read the owning host's
 * sort stamps; plus every Smart tier, which only a stamping host writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { SmartStampFields } from '../../../../shared/sidebar-list/sort-stamps'
import { GOLDEN_NOW } from './sidebar-list-golden-factories.test-fixture'
import { buildGoldenStoreState, type GoldenView } from './sidebar-list-golden-store.test-fixture'
import {
  appendCapture,
  captureScenario,
  defineSidebarListGoldens,
  GROUP_BYS,
  initialState
} from './sidebar-list-golden-suite.test-fixture'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
// Main's list session is a runtime call with no bearing on the rows.
vi.mock('@/lib/sidebar-list-session', () => ({ useSidebarListSession: () => {} }))

const GOLDEN_DIR = './__goldens__/sidebar-list-stamp-order'

defineSidebarListGoldens(GOLDEN_DIR)

// One row per tier and tie: two Done rows a second apart, two Working rows (the older one resumed
// after an approval keeps the ask's time), and Rest rows that only Recent orders.
const TIERS: Record<string, SmartStampFields> = {
  Zeta: { smartTier: 'needs-you', smartAt: GOLDEN_NOW - 600_000 },
  'feat-a': { smartTier: 'done', smartAt: GOLDEN_NOW - 60_000 },
  'api-y': { smartTier: 'done', smartAt: GOLDEN_NOW - 59_000 },
  'remote-x': { smartTier: 'working', smartAt: GOLDEN_NOW - 30_000 },
  'gitlab-mr': { smartTier: 'working', smartAt: GOLDEN_NOW - 900_000 }
}

function stampTierState(): Partial<AppState> {
  const base = buildGoldenStoreState({
    groupBy: 'none',
    sortBy: 'smart',
    projectOrderBy: 'manual',
    pinnedInGroups: false,
    collapsedGroups: new Set()
  })
  const worktreesByRepo: AppState['worktreesByRepo'] = {}
  for (const [repoId, worktrees] of Object.entries(base.worktreesByRepo ?? {})) {
    worktreesByRepo[repoId] = worktrees.map((worktree) => {
      const branch = worktree.branch.replace('refs/heads/', '')
      return TIERS[branch] ? { ...worktree, ...TIERS[branch] } : worktree
    })
  }
  return {
    worktreesByRepo,
    folderWorkspaces: (base.folderWorkspaces ?? []).map((folder) =>
      folder.id === 'fw-notes'
        ? { ...folder, smartTier: 'needs-you', smartAt: GOLDEN_NOW - 1_000 }
        : folder
    )
  }
}

describe('sidebar row model goldens: stamp tiers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(GOLDEN_NOW)
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  it('orders Needs you, Done, Working and Rest across groupBy and pinned policy', async () => {
    const sections: string[] = []
    const seen = new Map<string, string>()
    for (const sortBy of ['smart', 'recent'] as const) {
      for (const groupBy of GROUP_BYS) {
        for (const pinnedInGroups of [false, true]) {
          const view: GoldenView = {
            groupBy,
            sortBy,
            projectOrderBy: 'recent',
            pinnedInGroups,
            collapsedGroups: new Set()
          }
          appendCapture(
            sections,
            seen,
            `sort=${sortBy} groupBy=${groupBy} pinnedInGroups=${pinnedInGroups}`,
            captureScenario(view, stampTierState())
          )
          useAppStore.setState(initialState, true)
        }
      }
    }
    await expect(`${sections.join('\n')}\n`).toMatchFileSnapshot(
      `${GOLDEN_DIR}/scenario-stamp-tiers.txt`
    )
  })
})
