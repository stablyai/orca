// Assert tab management through rendered DOM: setup/store writes alone previously passed despite render crashes (#1186/#1193).
// Hidden-window drag setup may use production store actions, but final selection/order/count assertions still read DOM.

import { rm } from 'node:fs/promises'
import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  ensureTerminalVisible,
  waitForStartupWorktreeRefresh
} from '../../desktop/renderer-probes/store'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function tabLocator(page: Page, tabId: string) {
  return page.locator(`${SORTABLE_TAB}[data-tab-id="${tabId}"]`).first()
}

async function closeTabFromTabBar(page: Page, tabId: string): Promise<void> {
  const tab = tabLocator(page, tabId)
  await tab.hover()
  await tab.getByRole('button', { name: /^Close tab /i }).click()
  const confirmation = page.getByRole('dialog', { name: 'Stop running command?' })
  // A shell still starting under load may require the running-command confirmation.
  await expect
    .poll(async () => (await confirmation.isVisible()) || (await tab.count()) === 0, {
      timeout: 5_000
    })
    .toBe(true)
  if (await confirmation.isVisible()) {
    await confirmation.getByRole('button', { name: 'Stop and Close', exact: true }).click()
  }
}

/** Count rendered tabs in the tab bar (user-visible, not store-level). */
async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

// Read DOM data-active so a correct store id cannot hide a broken rendered selection indicator.
async function getDomActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    const match = document.querySelector(`${selector}[data-active="true"]`)
    return match?.getAttribute('data-tab-id') ?? null
  }, SORTABLE_TAB)
}

test.describe('Tabs', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForStartupWorktreeRefresh(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const initialTabId = (await getActiveTabId(orcaPage))!
    await expect(tabLocator(orcaPage, initialTabId)).toBeVisible()
  })

  // Use the real + → New Terminal flow and require a new rendered tab.

  test('clicking "+" then "New Markdown" focuses the editor', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    let createdFilePath: string | null = null
    registerPostElectronShutdownCleanup(async () => {
      if (createdFilePath) {
        await rm(createdFilePath, { force: true })
      }
    })

    const preExistingFileIds = await orcaPage.evaluate(
      () => window.__store?.getState().openFiles.map((file) => file.id) ?? []
    )

    await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
    const newMarkdownMenuItem = orcaPage
      .getByRole('menu')
      .getByRole('button', { name: 'New Markdown' })
      .first()
    await newMarkdownMenuItem.click()

    // Require a newly minted id and retain its cleanup path so existing Markdown cannot satisfy or be deleted by this test.
    const createdFileHandle = await orcaPage.waitForFunction(
      (knownFileIds) => {
        const state = window.__store?.getState()
        const file = state?.openFiles.find((candidate) => candidate.id === state.activeFileId)
        if (!file || knownFileIds.includes(file.id)) {
          return null
        }
        return { id: file.id, filePath: file.filePath }
      },
      preExistingFileIds,
      { timeout: 25_000 }
    )
    const createdFile = (await createdFileHandle.jsonValue())!
    createdFilePath = createdFile.filePath

    const editor = orcaPage.locator('.rich-markdown-editor')
    await expect(editor).toBeVisible({ timeout: 25_000 })
    await expect(newMarkdownMenuItem).toBeHidden({ timeout: 3_000 })

    await expect
      .poll(() => editor.evaluate((element) => document.activeElement === element), {
        timeout: 5_000,
        message: 'Menu-created Markdown editor did not receive keyboard focus'
      })
      .toBe(true)

    const sentinel = `autofocus-${Date.now()}`
    // Why: typing through the page keyboard proves focus landed without an editor click.
    await orcaPage.keyboard.type(sentinel)
    await expect(editor).toContainText(sentinel)

    await orcaPage.evaluate((fileId) => {
      window.__store?.getState().closeFile(fileId)
    }, createdFile.id)
    await expect(editor).toBeHidden()
  })

  test('clicking tabs still switches after dragging a terminal tab to reorder', async ({
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await orcaPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = (state.tabsByWorktree[targetWorktreeId] ?? []).length
      for (let i = existing; i < 2; i++) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(orcaPage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const domOrderBefore = await orcaPage.$$eval(SORTABLE_TAB, (nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
    )
    const [firstTabId, secondTabId] = domOrderBefore
    expect(firstTabId).toBeTruthy()
    expect(secondTabId).toBeTruthy()

    await tabLocator(orcaPage, firstTabId).click({ force: true })
    await expect.poll(() => getDomActiveTabId(orcaPage), { timeout: 3_000 }).toBe(firstTabId)

    const firstTabBox = await tabLocator(orcaPage, firstTabId).boundingBox()
    const secondTabBox = await tabLocator(orcaPage, secondTabId).boundingBox()
    expect(firstTabBox).not.toBeNull()
    expect(secondTabBox).not.toBeNull()
    const startX = firstTabBox!.x + firstTabBox!.width / 2
    const startY = firstTabBox!.y + firstTabBox!.height / 2
    const endX = secondTabBox!.x + secondTabBox!.width * 0.75
    const endY = secondTabBox!.y + secondTabBox!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    // Drag far enough for dnd-kit to reorder, then release over the strip before selecting again.
    await orcaPage.mouse.move(endX, endY, { steps: 8 })
    await orcaPage.mouse.up()

    await expect
      .poll(
        async () =>
          orcaPage.$$eval(SORTABLE_TAB, (nodes) =>
            nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
          ),
        { timeout: 5_000, message: 'Terminal tab drag did not reorder the tab strip' }
      )
      .toEqual([secondTabId, firstTabId, ...domOrderBefore.slice(2)])

    await tabLocator(orcaPage, firstTabId).click({ force: true })
    await expect.poll(() => getDomActiveTabId(orcaPage), { timeout: 3_000 }).toBe(firstTabId)
    await tabLocator(orcaPage, secondTabId).click({ force: true })
    await expect
      .poll(() => getDomActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'Tab click did not activate after a terminal tab reorder drag'
      })
      .toBe(secondTabId)
  })

  // After reorder, Cmd/Ctrl+Shift+[ must follow the visible group order, not stale tabBarOrderByWorktree.
  // Require DOM data-active to follow each expected tab as well as store selection.

  // Click the real X and require DOM removal so store-only close cannot hide a stuck tab.
  test('closing the active tab removes it and activates a neighbor', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Need a second tab so we can close one without deactivating the worktree.
    await orcaPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      if ((state.tabsByWorktree[targetWorktreeId] ?? []).length < 2) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(orcaPage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const tabsBefore = await countRenderedTabs(orcaPage)
    const activeId = await getActiveTabId(orcaPage)
    expect(activeId).not.toBeNull()
    await closeTabFromTabBar(orcaPage, activeId!)

    await expect
      .poll(() => countRenderedTabs(orcaPage), {
        timeout: 5_000,
        message: 'Clicking close did not remove the tab element from the DOM'
      })
      .toBe(tabsBefore - 1)
    await expect.poll(() => getDomActiveTabId(orcaPage), { timeout: 5_000 }).not.toBe(activeId)
    await expect.poll(() => getDomActiveTabId(orcaPage), { timeout: 5_000 }).not.toBeNull()
  })
})
