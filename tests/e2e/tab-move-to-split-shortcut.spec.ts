/** Drives a real chord because store-only tests cannot prove the shortcut reaches its handler. */

import { test, expect } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getActiveTabId
} from './helpers/store'
import { openTerminalTabInActiveGroup } from './helpers/terminal-tab-open'

// Mod+Alt+M is unused by the built-in map, so the chord cannot be stolen by another action.
const CHORD = 'Mod+Alt+M'

test('a bound chord moves the active tab into a split pane column', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)

  // A lone tab cannot move — dropUnifiedTab rejects splitting a group's only tab.
  await openTerminalTabInActiveGroup(orcaPage)

  await orcaPage.evaluate(async (chord) => {
    await window.__store!.getState().setKeybindingOverride('tab.moveToSplitRight', [chord])
  }, CHORD)

  // Why not countVisibleTerminalPanes(): that counts terminal panes *inside* one tab (the Cmd+D
  // split). Moving a tab to a split creates a new tab group, and each group renders its own strip.
  // Scoped to the active worktree because hidden worktree surfaces stay mounted and would be counted.
  const worktreeId = await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId)
  const groupStrips = orcaPage.locator(
    `[data-tab-group-strip-id][data-worktree-id="${worktreeId}"]`
  )
  await expect(groupStrips).toHaveCount(1)

  const activeTabId = await getActiveTabId(orcaPage)
  expect(activeTabId).not.toBeNull()
  await orcaPage
    .locator(`[data-testid="sortable-tab"][data-tab-id="${activeTabId}"]`)
    .click({ button: 'right' })
  const contextMenu = orcaPage.getByRole('menu')
  await expect(contextMenu).toBeVisible()
  await contextMenu.getByRole('menuitem').first().hover()

  const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
  const splitMenu = orcaPage.getByRole('menu').nth(1)
  const rightMenuItem = splitMenu.getByRole('menuitem').first()
  await expect(rightMenuItem).toBeVisible()
  await expect(rightMenuItem.locator('[data-slot="dropdown-menu-shortcut"]')).toHaveText(
    isMac ? '⌘⌥M' : 'Ctrl+Alt+M'
  )
  await orcaPage.keyboard.press('Escape')

  // Why: a real input/contenteditable suppresses global shortcuts, but the xterm textarea is carved
  // out of isEditableTarget — so blur everything except it, leaving the terminal's normal focus state.
  await orcaPage.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !active.classList.contains('xterm-helper-textarea')) {
      active.blur()
    }
  })

  // pressShortcut() has no Alt option, so resolve the platform modifier here.
  await orcaPage.keyboard.press(`${isMac ? 'Meta' : 'Control'}+Alt+m`)

  await expect(groupStrips, 'the bound chord did not move the tab into a new group').toHaveCount(
    2,
    {
      timeout: 5_000
    }
  )
})
