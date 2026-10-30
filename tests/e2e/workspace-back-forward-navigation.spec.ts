// Drive Back/Forward buttons and Cmd/Ctrl+Alt+Arrow through DOM view guards, history dedupe/truncation and shortcuts.

import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getAllWorktreeIds,
  ensureTerminalVisible
} from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

// Seed in production order: setActiveWorktree then recordWorktreeVisit; actual history navigation skips recording.
async function seedVisit(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    // runtime-types exposes a minimal store type; runtime Zustand also supports navigation slice actions.
    type StoreLike = {
      getState: () => {
        setActiveWorktree: (worktreeId: string) => void
        recordWorktreeVisit: (worktreeId: string) => void
      }
    }
    const store = window.__store as unknown as StoreLike
    const state = store.getState()
    state.setActiveWorktree(id)
    state.recordWorktreeVisit(id)
  }, worktreeId)
}

async function getNavHistorySnapshot(page: Page): Promise<{ history: string[]; index: number }> {
  return page.evaluate(() => {
    type StoreLike = {
      getState: () => {
        worktreeNavHistory: string[]
        worktreeNavHistoryIndex: number
      }
    }
    const store = window.__store as unknown as StoreLike
    const state = store.getState()
    return {
      history: [...state.worktreeNavHistory],
      index: state.worktreeNavHistoryIndex
    }
  })
}

async function resetNavHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreLike = {
      setState: (partial: { worktreeNavHistory: string[]; worktreeNavHistoryIndex: number }) => void
    }
    const store = window.__store as unknown as StoreLike
    store.setState({ worktreeNavHistory: [], worktreeNavHistoryIndex: -1 })
  })
}

async function getBackButton(page: Page) {
  return page.getByRole('button', { name: 'Go back' })
}

async function getForwardButton(page: Page) {
  return page.getByRole('button', { name: 'Go forward' })
}

const isMac = process.platform === 'darwin'
const mod = isMac ? 'Meta' : 'Control'

test.describe('Workspace Back/Forward Navigation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('buttons are hidden outside the terminal view', async ({ orcaPage }) => {
    await expect(await getBackButton(orcaPage)).toBeVisible()
    await expect(await getForwardButton(orcaPage)).toBeVisible()

    // Outside-history views must omit navigation buttons entirely.
    await orcaPage.evaluate(() => {
      window.__store!.getState().openSettingsPage()
    })

    await expect(await getBackButton(orcaPage)).toHaveCount(0)
    await expect(await getForwardButton(orcaPage)).toHaveCount(0)

    await orcaPage.evaluate(() => {
      window.__store!.getState().setActiveView('terminal')
    })
    await expect(await getBackButton(orcaPage)).toBeVisible()
  })

  test('both buttons disabled at cold start with a single history entry', async ({ orcaPage }) => {
    // Reset fixture-dependent history and seed exactly one visit.
    const activeId = await getActiveWorktreeId(orcaPage)
    expect(activeId).not.toBeNull()

    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, activeId!)

    const back = await getBackButton(orcaPage)
    const forward = await getForwardButton(orcaPage)
    await expect(back).toBeDisabled()
    await expect(forward).toBeDisabled()
  })

  test('clicking Back and Forward walks the history stack', async ({ orcaPage }) => {
    const worktreeIds = await getAllWorktreeIds(orcaPage)
    test.skip(worktreeIds.length < 2, 'Need at least two worktrees to exercise back/forward')
    const [primaryId, secondaryId] = worktreeIds

    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, primaryId)
    await seedVisit(orcaPage, secondaryId)

    const back = await getBackButton(orcaPage)
    const forward = await getForwardButton(orcaPage)
    await expect(back).toBeEnabled()
    await expect(forward).toBeDisabled()

    // Assert sidebar aria-current for active worktree; aria-selected tracks batch selection and store-only reads miss render regressions.
    const primaryRow = worktreeRow(orcaPage, primaryId)
    const secondaryRow = worktreeRow(orcaPage, secondaryId)

    await back.click()
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        message: 'Back click did not activate the previous worktree'
      })
      .toBe(primaryId)
    await expect(primaryRow).toHaveAttribute('aria-current', 'page')
    await expect(secondaryRow).not.toHaveAttribute('aria-current', 'page')
    await expect(back).toBeDisabled()
    await expect(forward).toBeEnabled()

    await forward.click()
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        message: 'Forward click did not re-activate the next worktree'
      })
      .toBe(secondaryId)
    await expect(secondaryRow).toHaveAttribute('aria-current', 'page')
    await expect(primaryRow).not.toHaveAttribute('aria-current', 'page')
    await expect(forward).toBeDisabled()
  })

  test('re-activating the current worktree is a no-op (dedupe)', async ({ orcaPage }) => {
    const activeId = await getActiveWorktreeId(orcaPage)
    expect(activeId).not.toBeNull()

    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, activeId!)
    await seedVisit(orcaPage, activeId!)
    await seedVisit(orcaPage, activeId!)

    const snapshot = await getNavHistorySnapshot(orcaPage)
    expect(snapshot.history).toEqual([activeId])
    expect(snapshot.index).toBe(0)
    await expect(await getBackButton(orcaPage)).toBeDisabled()
  })

  test('new navigation after going back truncates the forward stack', async ({ orcaPage }) => {
    const worktreeIds = await getAllWorktreeIds(orcaPage)
    test.skip(worktreeIds.length < 2, 'Need at least two worktrees to exercise forward truncation')
    const [primaryId, secondaryId] = worktreeIds

    // From primary→secondary, go back then re-visit primary to test current-entry dedupe before a new secondary activation truncates forward history.
    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, primaryId)
    await seedVisit(orcaPage, secondaryId)
    await (await getBackButton(orcaPage)).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(primaryId)

    await expect(await getForwardButton(orcaPage)).toBeEnabled()

    // Re-activate secondary mid-history; require [primary,secondary] at index 1 and disabled Forward.
    await seedVisit(orcaPage, secondaryId)
    const snapshot = await getNavHistorySnapshot(orcaPage)
    expect(snapshot.history).toEqual([primaryId, secondaryId])
    expect(snapshot.index).toBe(1)
    await expect(await getForwardButton(orcaPage)).toBeDisabled()
  })

  test(`${isMac ? 'Cmd' : 'Ctrl'}+Alt+Left/Right shortcuts walk history`, async ({ orcaPage }) => {
    const worktreeIds = await getAllWorktreeIds(orcaPage)
    test.skip(worktreeIds.length < 2, 'Need at least two worktrees to exercise shortcuts')
    const [primaryId, secondaryId] = worktreeIds

    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, primaryId)
    await seedVisit(orcaPage, secondaryId)

    // Focus body so editable-target checks cannot swallow the window shortcut in hidden Electron.
    await orcaPage.evaluate(() => document.body.focus())

    await orcaPage.keyboard.press(`${mod}+Alt+ArrowLeft`)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        message: `${mod}+Alt+Left did not navigate back`
      })
      .toBe(primaryId)

    await orcaPage.keyboard.press(`${mod}+Alt+ArrowRight`)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        message: `${mod}+Alt+Right did not navigate forward`
      })
      .toBe(secondaryId)
  })

  test('shortcut is a no-op in settings view', async ({ orcaPage }) => {
    const worktreeIds = await getAllWorktreeIds(orcaPage)
    test.skip(worktreeIds.length < 2, 'Need at least two worktrees to exercise settings gating')
    const [primaryId, secondaryId] = worktreeIds

    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, primaryId)
    await seedVisit(orcaPage, secondaryId)

    // Settings is outside history; its shortcut must preserve active worktree.
    await orcaPage.evaluate(() => {
      window.__store!.getState().openSettingsPage()
    })
    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store!.getState().activeView))
      .toBe('settings')

    const idBefore = await getActiveWorktreeId(orcaPage)
    await orcaPage.evaluate(() => document.body.focus())
    await orcaPage.keyboard.press(`${mod}+Alt+ArrowLeft`)

    // Allow erroneous navigation to land before requiring unchanged worktree/index.
    await orcaPage.waitForTimeout(150)
    expect(await getActiveWorktreeId(orcaPage)).toBe(idBefore)
    const snapshot = await getNavHistorySnapshot(orcaPage)
    expect(snapshot.index).toBe(1)
  })
})
