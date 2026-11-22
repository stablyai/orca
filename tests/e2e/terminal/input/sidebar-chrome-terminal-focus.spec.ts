import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { resolveActiveTabId } from '../layout/terminal-pane-identity'
import { waitForActiveTerminalManager } from '../layout/terminal-pane-operations'
import { expectTerminalAccessibilityText } from './terminal-accessibility-tree'

async function focusActiveTerminal(page: Page): Promise<{ tabId: string }> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('No active terminal tab')
  }
  const helper = page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`)
  await page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-screen`).click()
  await expect(helper).toBeFocused()
  return { tabId }
}

function terminalHelper(page: Page, tabId: string) {
  return page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`)
}

test.beforeEach(async ({ orcaPage }) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
})

for (const position of ['top', 'side'] as const) {
  test(`mouse panel tab switches keep terminal input with the ${position} activity bar`, async ({
    orcaPage
  }) => {
    await orcaPage.evaluate((position) => {
      const state = window.__store!.getState()
      state.setActivityBarPosition(position)
      state.setRightSidebarTab('explorer')
      state.setRightSidebarOpen(true)
    }, position)
    const { tabId } = await focusActiveTerminal(orcaPage)

    await orcaPage.getByRole('button', { name: /^Agents/ }).click()
    await expect(orcaPage.getByRole('textbox', { name: 'Search sessions' })).toBeVisible()
    await expect(terminalHelper(orcaPage, tabId)).toBeFocused()

    await orcaPage.getByRole('button', { name: /^Explorer/ }).click()
    await expect(orcaPage.getByRole('textbox', { name: 'Find files' })).toBeVisible()
    await expect(terminalHelper(orcaPage, tabId)).toBeFocused()

    const marker = `sidebar-tab-${position}`
    await orcaPage.keyboard.type(marker)
    await expectTerminalAccessibilityText(orcaPage, tabId, marker)
  })
}

test('picking a panel from the More menu with the mouse keeps terminal input', async ({
  orcaPage
}) => {
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setActivityBarPosition('top')
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(true)
  })
  // Force overflow without installing plugins just to add more tabs.
  await orcaPage.locator('.right-sidebar-activity-strip').evaluate((strip) => {
    if (strip instanceof HTMLElement) {
      strip.style.maxWidth = '100px'
    }
  })
  const { tabId } = await focusActiveTerminal(orcaPage)

  const more = orcaPage.getByRole('button', { name: 'More sidebar tabs' })
  const menu = orcaPage.getByRole('menu')
  // Dismissing with an outside click must not park focus on More for the next pick.
  await more.click()
  await expect(menu).toBeVisible()
  await orcaPage.mouse.click(400, 400)
  await expect(menu).toHaveCount(0)
  await expect(terminalHelper(orcaPage, tabId)).toBeFocused()

  await more.click()
  await menu.getByRole('menuitem', { name: /^Agents/ }).click()
  await expect(menu).toHaveCount(0)
  await expect(orcaPage.getByRole('textbox', { name: 'Search sessions' })).toBeVisible()
  await expect(terminalHelper(orcaPage, tabId)).toBeFocused()
})

test('keyboard activation of the Agents tab still focuses its search', async ({ orcaPage }) => {
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setActivityBarPosition('top')
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(true)
  })
  const agents = orcaPage.getByRole('button', { name: /^Agents/ })
  await agents.focus()
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.getByRole('textbox', { name: 'Search sessions' })).toBeFocused()
})

test('toggling the left sidebar with the mouse keeps terminal input', async ({ orcaPage }) => {
  const { tabId } = await focusActiveTerminal(orcaPage)
  const toggle = orcaPage.getByRole('button', { name: 'Toggle sidebar', exact: true })
  await toggle.click()
  await expect(terminalHelper(orcaPage, tabId)).toBeFocused()
  await toggle.click()
  await expect(terminalHelper(orcaPage, tabId)).toBeFocused()

  await orcaPage.keyboard.type('left-sidebar-toggle')
  await expectTerminalAccessibilityText(orcaPage, tabId, 'left-sidebar-toggle')
})

for (const position of ['top', 'side'] as const) {
  test(`toggling the right sidebar with the mouse keeps terminal input with the ${position} activity bar`, async ({
    orcaPage
  }) => {
    await orcaPage.evaluate((position) => {
      const state = window.__store!.getState()
      state.setActivityBarPosition(position)
      state.setRightSidebarTab('explorer')
      state.setRightSidebarOpen(false)
    }, position)
    const { tabId } = await focusActiveTerminal(orcaPage)
    // The titlebar opens it and the sidebar header closes it; only one is rendered at a time.
    const toggle = orcaPage.getByRole('button', { name: 'Toggle right sidebar', exact: true })
    await toggle.click()
    await expect(orcaPage.getByRole('textbox', { name: 'Find files' })).toBeVisible()
    await expect(terminalHelper(orcaPage, tabId)).toBeFocused()
    await toggle.click()
    await expect(orcaPage.getByRole('textbox', { name: 'Find files' })).toHaveCount(0)
    await expect(terminalHelper(orcaPage, tabId)).toBeFocused()

    const marker = `right-sidebar-toggle-${position}`
    await orcaPage.keyboard.type(marker)
    await expectTerminalAccessibilityText(orcaPage, tabId, marker)
  })
}
