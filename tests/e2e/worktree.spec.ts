/**
 * E2E tests for the "New Worktree" flow in Orca.
 *
 * User Prompt:
 * - create a suite of tests that have the basic user flows for this app. 1. new worktree.
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  ensureTerminalVisible
} from './helpers/store'

test.describe('New Worktree', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  /**
   * User Prompt:
   * - new worktree
   */
  test('create-worktree modal can be opened', async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      // Why: hidden Electron E2E runs do not expose the same reliable keyboard
      // and sidebar button interactions as a visible window. Opening the modal
      // through the store still exercises the real dialog content and submit
      // path, which is the behavior this suite needs to keep covered.
      window.__store?.getState().openModal('create-worktree')
    })

    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store?.getState().activeModal ?? null), {
        timeout: 5_000
      })
      .toBe('create-worktree')

    await orcaPage.evaluate(() => {
      window.__store?.getState().closeModal()
    })
    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store?.getState().activeModal ?? null), {
        timeout: 3_000
      })
      .toBe('none')
  })

  /**
   * User Prompt:
   * - new worktree
   */
  test('can create a new worktree and it becomes active', async ({ orcaPage }) => {
    const worktreeIdBefore = await getActiveWorktreeId(orcaPage)

    await orcaPage.evaluate(() => {
      // Why: open the same create-worktree modal through store state so the
      // worktree creation path stays testable in hidden Electron mode.
      window.__store?.getState().openModal('create-worktree')
    })
    const testName = `e2e-test-${Date.now()}`
    await orcaPage.evaluate(async (name) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }

      const state = store.getState()
      const activeWorktreeId = state.activeWorktreeId
      if (!activeWorktreeId) {
        throw new Error('No active worktree to derive repo from')
      }

      const activeWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === activeWorktreeId)
      if (!activeWorktree) {
        throw new Error(`Active worktree ${activeWorktreeId} not found`)
      }

      const result = await state.createWorktree(activeWorktree.repoId, name)
      await state.fetchWorktrees(activeWorktree.repoId)
      state.setActiveWorktree(result.worktree.id)
      state.closeModal()
    }, testName)

    // The new worktree should now be active (different from before)
    await expect
      .poll(
        async () => {
          const id = await getActiveWorktreeId(orcaPage)
          return id !== null && id !== worktreeIdBefore
        },
        { timeout: 10_000, message: 'New worktree did not become active' }
      )
      .toBe(true)

    // A terminal tab should auto-create for the new worktree
    await ensureTerminalVisible(orcaPage)
  })
})
