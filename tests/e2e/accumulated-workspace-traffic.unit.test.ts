import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@stablyai/playwright-test'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import {
  cleanupAccumulatedWorkspaceFixture,
  seedAccumulatedWorkspaceFixture
} from './accumulated-workspace-fixture'
import {
  startAccumulatedOrderTraffic,
  stopAccumulatedOrderTraffic
} from './accumulated-workspace-order-fixture'

function rendererFixture() {
  vi.useFakeTimers()
  const store = createTestStore()
  store.setState({ settings: createGlobalSettingsFixture() })
  vi.stubGlobal('window', { __store: store, setInterval, clearInterval })
  const page = {
    evaluate: async (callback: (arg: never) => unknown, arg: never) => callback(arg)
  }
  return {
    store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixtures only use evaluate, which executes against the real store.
    page: page as unknown as Page
  }
}

const smallProfile = {
  repositories: 2,
  worktrees: 3,
  terminalTabs: 3,
  unifiedTabs: 3,
  sleepingRecords: 0,
  liveStatuses: 0
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('accumulated workspace benchmark setup', () => {
  it.each([undefined, 'full'])(
    'applies the requested agent row mode (%s) and restores preferences on cleanup',
    async (mode) => {
      vi.stubEnv('ORCA_TYPING_BENCH_AGENT_ROWS', mode)
      const { store, page } = rendererFixture()
      const before = store.getState()
      expect(before.agentActivityDisplayMode).toBe('compact')

      await seedAccumulatedWorkspaceFixture(page, smallProfile)
      const seeded = store.getState()
      expect(seeded.agentActivityDisplayMode).toBe(mode ?? before.agentActivityDisplayMode)
      expect(seeded.worktreeCardProperties).toEqual(
        mode === 'full' ? ['status', 'inline-agents'] : before.worktreeCardProperties
      )

      await cleanupAccumulatedWorkspaceFixture(page)
      expect(store.getState().agentActivityDisplayMode).toBe(before.agentActivityDisplayMode)
      expect(store.getState().worktreeCardProperties).toEqual(before.worktreeCardProperties)
    }
  )
})

describe('accumulated workspace order traffic', () => {
  it.each([2, 3])(
    'counts only store publications with %i workspaces in two repos',
    async (worktrees) => {
      const { store, page } = rendererFixture()
      await seedAccumulatedWorkspaceFixture(page, { ...smallProfile, worktrees })
      const before = store.getState()
      const publications: number[] = []
      const unsubscribe = store.subscribe((state) => publications.push(state.sortOrderEpoch))

      expect(await startAccumulatedOrderTraffic(page, 10)).toBe(2)
      await vi.advanceTimersByTimeAsync(20)
      const stats = await stopAccumulatedOrderTraffic(page)

      const expectedPublications = worktrees === 3 ? 1 : 0
      expect(stats?.publications).toBe(expectedPublications)
      expect(stats?.publications).toBe(publications.length)
      expect(stats?.rowsRepublished).toBe(expectedPublications * 2)
      expect(store.getState().sortOrderEpoch - before.sortOrderEpoch).toBe(expectedPublications)
      if (expectedPublications) {
        expect(
          store.getState().worktreesByRepo['synthetic-repo-0'].map((row) => row.sortOrder)
        ).toEqual([1, 0])
      } else {
        expect(store.getState()).toBe(before)
        expect(stats?.syncPublishMs).toEqual({ total: 0, max: 0 })
      }
      await vi.advanceTimersByTimeAsync(20)
      expect(publications).toHaveLength(expectedPublications)
      unsubscribe()
      expect(await stopAccumulatedOrderTraffic(page)).toBeNull()
    }
  )
})
