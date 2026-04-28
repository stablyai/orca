/**
 * E2E tests for the workspace Back / Forward titlebar buttons + their
 * Cmd/Ctrl+Alt+Arrow shortcuts.
 *
 * Covers edge cases that unit tests cannot exercise:
 *   - Button DOM disabled/hidden states across view transitions.
 *   - De-dup: re-activating the current worktree does not grow history.
 *   - Forward-stack truncation after a mid-history activation.
 *   - Keyboard shortcuts fire the same back/forward path as clicks.
 *   - Shortcuts no-op in non-terminal views (buttons also hidden there).
 */

import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getAllWorktreeIds,
  ensureTerminalVisible
} from './helpers/store'

/**
 * Record a visit through the same two store calls that
 * `activateAndRevealWorktree` makes for the history slice, without having to
 * expose the activation helper on window. This mirrors production ordering:
 * `setActiveWorktree` first, then `recordWorktreeVisit` (skipped by the real
 * helper when `isNavigatingHistory` is true — not relevant for seeding).
 */
async function seedVisit(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    // Why: window.__store is typed minimally in runtime-types.ts. At runtime it
    // is the full Zustand vanilla store (setState/getState/subscribe), so we
    // widen to call the nav-history slice actions directly.
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

    // Why: the Back/Forward pair is conditional on `activeView === 'terminal'`.
    // Settings, Tasks, and Landing must not render the buttons at all (not just
    // disable them) so the titlebar stays compact and the semantics unambiguous.
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
    // The test fixture already activated a worktree during setup, so one entry
    // may or may not exist. Reset the slice to a known empty baseline, then
    // record the current worktree as the single entry.
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

    // Why: use the sidebar's `role="option"` + `aria-selected="true"` as the
    // DOM signal for "this worktree is currently active". A store-only
    // `activeWorktreeId` check would pass even if the sidebar stopped
    // re-painting the selected row — exactly the kind of render-layer
    // regression the AGENTS.md rule targets.
    const primaryRow = orcaPage.locator(
      `[id="worktree-list-option-${encodeURIComponent(primaryId)}"]`
    )
    const secondaryRow = orcaPage.locator(
      `[id="worktree-list-option-${encodeURIComponent(secondaryId)}"]`
    )

    await back.click()
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        message: 'Back click did not activate the previous worktree'
      })
      .toBe(primaryId)
    await expect(primaryRow).toHaveAttribute('aria-selected', 'true')
    await expect(secondaryRow).toHaveAttribute('aria-selected', 'false')
    await expect(back).toBeDisabled()
    await expect(forward).toBeEnabled()

    await forward.click()
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        message: 'Forward click did not re-activate the next worktree'
      })
      .toBe(secondaryId)
    await expect(secondaryRow).toHaveAttribute('aria-selected', 'true')
    await expect(primaryRow).toHaveAttribute('aria-selected', 'false')
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

    // Stack: primary -> secondary. Go back to primary, then "activate" primary
    // again via a fresh visit (simulating a sidebar click on the same entry
    // from mid-history). The current-entry dedupe should kick in, but if we
    // instead activate secondary while sitting on primary mid-history, the
    // forward entry pointing at secondary must be truncated.
    await resetNavHistory(orcaPage)
    await seedVisit(orcaPage, primaryId)
    await seedVisit(orcaPage, secondaryId)
    await (await getBackButton(orcaPage)).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(primaryId)

    // Forward button is live — a forward entry exists.
    await expect(await getForwardButton(orcaPage)).toBeEnabled()

    // Fresh activation from mid-history. Using secondary again is the simplest
    // way to prove truncation happened: after this call, the stack must be
    // [primary, secondary] with index=1, so Forward is disabled even though
    // there *was* a forward entry moments ago.
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

    // Why: focus body so the window-level keydown capture handler runs without
    // an `isEditableTarget` bail-out. The xterm helper textarea is explicitly
    // treated as non-editable, but body is the simplest stable target in a
    // hidden-window Electron run.
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

    // Enter settings. The back shortcut must not change the active worktree,
    // matching the view-guard in App.tsx and useIpcEvents.ts.
    await orcaPage.evaluate(() => {
      window.__store!.getState().openSettingsPage()
    })
    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store!.getState().activeView))
      .toBe('settings')

    const idBefore = await getActiveWorktreeId(orcaPage)
    await orcaPage.evaluate(() => document.body.focus())
    await orcaPage.keyboard.press(`${mod}+Alt+ArrowLeft`)

    // Give any erroneous nav a beat to land, then assert the active worktree
    // and the slice index both stayed put.
    await orcaPage.waitForTimeout(150)
    expect(await getActiveWorktreeId(orcaPage)).toBe(idBefore)
    const snapshot = await getNavHistorySnapshot(orcaPage)
    expect(snapshot.index).toBe(1)
  })
})
