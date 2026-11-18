import 'node:fs'

import 'node:path'

import type { Locator, Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import '../../terminal/input/terminal'

const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'

async function openFloatingTerminals(page: Page): Promise<{ first: Locator; second: Locator }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const ids = await page.evaluate(async (worktreeId) => {
    const store = window.__store!
    await store.getState().updateSettings({ floatingTerminalEnabled: true })
    const first = store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
    const second = store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
    store.getState().setTabCustomTitle(first.id, 'Rename target')
    store.getState().setTabCustomTitle(second.id, 'Other terminal')
    store.setState({ floatingWorkspacePanelOpen: true })
    return [first.id, second.id]
  }, FLOATING_WORKTREE_ID)
  const panel = page.locator(OPEN_PANEL_SELECTOR)
  await expect(panel).toBeVisible()
  const first = panel.locator(`[data-testid="sortable-tab"][data-tab-id="${ids[0]}"]`)
  const second = panel.locator(`[data-testid="sortable-tab"][data-tab-id="${ids[1]}"]`)
  await first.click()
  await expect(first).toHaveAttribute('data-active', 'true')
  await expect(
    panel.locator(`[data-terminal-tab-id="${ids[0]}"] .xterm-helper-textarea`)
  ).toBeFocused()
  return { first, second }
}

async function beginRename(
  page: Page,
  tab: Locator,
  entry: 'menu' | 'double-click'
): Promise<Locator> {
  if (entry === 'menu') {
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Change Title(?:\s|$)/ }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  } else {
    await tab.dblclick()
  }
  const input = tab.locator('[data-tab-rename-input="true"]')
  await expect(input).toBeFocused()
  // Let activation's deferred focus finish while the rename input still owns focus.
  await settleDeferredFocus(page)
  return input
}

async function settleDeferredFocus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  })
}

async function expectKeyboardOutput(page: Page, tab: Locator, marker: string): Promise<void> {
  const tabId = await tab.getAttribute('data-tab-id')
  await expect(
    page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const pane = id ? window.__paneManagers?.get(id)?.getActivePane() : null
        return Boolean(pane?.container.dataset.ptyId && pane.serializeAddon?.serialize().trim())
      }, tabId)
    )
    .toBe(true)
  await settleDeferredFocus(page)
  await expect(
    page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(1)
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const buffer = id
          ? window.__paneManagers?.get(id)?.getActivePane()?.terminal.buffer.active
          : null
        if (!buffer) {
          return []
        }
        return Array.from({ length: buffer.length }, (_, index) =>
          buffer.getLine(index)?.translateToString(true).trim()
        )
      }, tabId)
    )
    .toContain(marker)
}

test('blur commits without taking keyboard input back from another floating tab', async ({
  orcaPage
}) => {
  const { first, second } = await openFloatingTerminals(orcaPage)
  const input = await beginRename(orcaPage, first, 'double-click')
  await input.fill('Blur committed')
  await second.click()
  await expect(input).toHaveCount(0)
  await expect(first).toHaveAttribute('data-tab-title', 'Blur committed')
  await expect(second).toHaveAttribute('data-active', 'true')
  await expectKeyboardOutput(orcaPage, second, 'ORCA_RENAME_BLUR')
})

test('renaming an inactive floating tab does not activate or focus its terminal', async ({
  orcaPage
}) => {
  const { first, second } = await openFloatingTerminals(orcaPage)
  const input = await beginRename(orcaPage, second, 'menu')
  await expect(first).toHaveAttribute('data-active', 'true')
  await input.fill('Inactive renamed')
  await orcaPage.keyboard.press('Enter')
  await expect(second).toHaveAttribute('data-tab-title', 'Inactive renamed')
  await settleDeferredFocus(orcaPage)
  await expect(first).toHaveAttribute('data-active', 'true')
  const secondId = await second.getAttribute('data-tab-id')
  await expect(
    orcaPage.locator(`[data-terminal-tab-id="${secondId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(0)
})

test('blur preserves focus in the worktree search dialog', async ({ orcaPage }) => {
  const { first } = await openFloatingTerminals(orcaPage)
  const input = await beginRename(orcaPage, first, 'double-click')
  await input.fill('Search committed')
  await orcaPage
    .getByRole('button', { name: 'Search worktrees and browser tabs', exact: true })
    .click()
  await expect(input).toHaveCount(0)
  await expect(first).toHaveAttribute('data-tab-title', 'Search committed')
  const search = orcaPage.getByRole('dialog').locator('input').first()
  await expect(search).toBeFocused()
  await settleDeferredFocus(orcaPage)
  await orcaPage.keyboard.type('search owns input')
  await expect(search).toHaveValue('search owns input')
})
