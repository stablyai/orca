/**
 * E2E test for the `tab.moveToSplitRight` keybinding (default Mod+\).
 *
 * Why E2E rather than a store-slice unit test: the split itself is already
 * covered at the slice level, but the thing under test here is the global
 * keyboard path — the window capture-phase handler in App.tsx resolving the
 * active tab and reaching `moveTabToNewPaneColumn`. Per tests/e2e/AGENTS.md,
 * keyboard shortcuts are one of the cases a unit test cannot reach.
 *
 * The final assertion counts rendered tab-group bodies, so a render regression
 * that leaves the layout tree correct but paints one pane still fails.
 */

import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getActiveTabType
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'

const GROUP_BODY = '[data-tab-group-body-id]'
const SORTABLE_TAB = '[data-testid="sortable-tab"]'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function countGroupBodies(page: Page): Promise<number> {
  return page.locator(GROUP_BODY).count()
}

async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

test.describe('Move tab to split shortcut', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test(`${MOD}+\\ moves the active tab into a new pane column`, async ({ orcaPage }) => {
    // The guard declines on a single-tab group, so seed a second tab first.
    // Setup goes through the store on purpose: the "+" menu's accessible name is
    // localized, and this spec is about Mod+\, not tab creation.
    await orcaPage.evaluate(() => {
      const store = window.__store
      const state = store?.getState()
      const worktreeId = state?.activeWorktreeId
      if (state && worktreeId) {
        state.createTab(worktreeId)
      }
    })
    await expect
      .poll(() => countRenderedTabs(orcaPage), {
        timeout: 10_000,
        message: 'Could not seed a second tab to split'
      })
      .toBeGreaterThan(1)

    const groupsBefore = await countGroupBodies(orcaPage)

    await orcaPage.evaluate(() => document.body.focus())
    await orcaPage.keyboard.press(`${MOD}+\\`)

    await expect
      .poll(() => countGroupBodies(orcaPage), {
        timeout: 5_000,
        message: `${MOD}+\\ did not render a second tab group body`
      })
      .toBe(groupsBefore + 1)
  })

  test(`${MOD}+\\ still splits while the Monaco editor holds focus`, async ({ orcaPage }) => {
    // Why this case exists: the global handler sits behind an `isEditableTarget`
    // guard, and Monaco's input is a <textarea>. Cursor/VS Code split while the
    // editor is focused, so the parity claim only holds if this passes.
    await openFileExplorer(orcaPage)
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      'README.md',
      '.gitignore'
    ])
    expect(clickedFile).not.toBeNull()
    await expect.poll(() => getActiveTabType(orcaPage), { timeout: 10_000 }).toBe('editor')

    const monaco = orcaPage.locator('.monaco-editor').first()
    await expect(monaco).toBeVisible({ timeout: 25_000 })
    await monaco.click()

    // Guard against a vacuous pass: if focus never reached Monaco's <textarea>,
    // the isEditableTarget branch was never exercised and this test proves nothing.
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const active = document.activeElement
            return active instanceof HTMLElement ? active.className : null
          }),
        { timeout: 5_000, message: 'Monaco never took keyboard focus' }
      )
      // Monaco's focused input is `native-edit-context` on the EditContext path
      // and `inputarea` on the legacy textarea path; accept either.
      .toMatch(/native-edit-context|inputarea/)

    const groupsBefore = await countGroupBodies(orcaPage)
    await orcaPage.keyboard.press(`${MOD}+\\`)

    await expect
      .poll(() => countGroupBodies(orcaPage), {
        timeout: 5_000,
        message: `${MOD}+\\ did not split while Monaco held focus`
      })
      .toBe(groupsBefore + 1)
  })

  test(`${MOD}+\\ still splits while a text input holds focus`, async ({ orcaPage }) => {
    // Why: the chord is dispatched ahead of the isEditableTarget guard, since it is a layout
    // command rather than text input. This pins that ordering — Monaco's EditContext div passes
    // the guard today, but its legacy textarea path would not.
    await openFileExplorer(orcaPage)
    await clickFileInExplorer(orcaPage, ['package.json', 'README.md', '.gitignore'])
    await expect.poll(() => getActiveTabType(orcaPage), { timeout: 10_000 }).toBe('editor')

    const focusedTag = await orcaPage.evaluate(() => {
      const input = document.querySelector('input:not([type="hidden"])')
      if (input instanceof HTMLElement) {
        input.focus()
      }
      return document.activeElement?.tagName ?? null
    })
    expect(focusedTag).toBe('INPUT')

    const groupsBefore = await countGroupBodies(orcaPage)
    await orcaPage.keyboard.press(`${MOD}+\\`)

    await expect
      .poll(() => countGroupBodies(orcaPage), {
        timeout: 5_000,
        message: `${MOD}+\\ did not split while a text input held focus`
      })
      .toBe(groupsBefore + 1)
  })

  test(`${MOD}+\\ is a no-op for a group holding a single tab`, async ({ orcaPage }) => {
    // Why: the chord must fall through rather than preventDefault, so a lone
    // tab is never moved into an empty column it would immediately re-merge from.
    await expect.poll(() => countRenderedTabs(orcaPage), { timeout: 5_000 }).toBe(1)
    const groupsBefore = await countGroupBodies(orcaPage)

    await orcaPage.evaluate(() => document.body.focus())
    await orcaPage.keyboard.press(`${MOD}+\\`)

    await expect(orcaPage.locator(GROUP_BODY)).toHaveCount(groupsBefore)
  })
})
