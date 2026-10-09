import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'
import { splitActiveTerminalPane, waitForPaneIdentitySnapshot } from './helpers/terminal'
import { readTerminalPaneDomLeafOrder } from './helpers/terminal-pane-operations'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

function tab(page: Page, id: string) {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id="${id}"]`).first()
}

function paneInput(page: Page, tabId: string, leafId: string) {
  return page
    .locator(`[data-terminal-tab-id="${tabId}"] [data-leaf-id="${leafId}"] .xterm-helper-textarea`)
    .first()
}

async function selectPane(page: Page, tabId: string, leafId: string) {
  await tab(page, tabId).click()
  await page
    .locator(`[data-terminal-tab-id="${tabId}"] [data-leaf-id="${leafId}"] .xterm-screen`)
    .first()
    .click()
  await expect(paneInput(page, tabId, leafId)).toBeFocused()
}

async function addTerminalTab(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = window.__store
    const worktreeId = store?.getState().activeWorktreeId
    if (!store || !worktreeId) {
      throw new Error('Test workspace is not ready')
    }
    return store.getState().createTab(worktreeId).id
  })
}

async function installNavigationBindings(page: Page) {
  await page.evaluate(async () => {
    await window.api.keybindings.setAction({ actionId: 'worktree.history.back', bindings: [] })
    await window.api.keybindings.setAction({ actionId: 'worktree.history.forward', bindings: [] })
    await window.api.keybindings.setAction({
      actionId: 'terminal.focusNextPaneAcrossTabs',
      bindings: ['Mod+Alt+ArrowRight']
    })
    await window.api.keybindings.setAction({
      actionId: 'terminal.focusPreviousPaneAcrossTabs',
      bindings: ['Mod+Alt+ArrowLeft']
    })
  })
}

test.beforeEach(async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await installNavigationBindings(orcaPage)
})

test('cycles visual pane order across tab boundaries and returns to the last pane', async ({
  orcaPage
}, testInfo) => {
  const first = await getActiveTabId(orcaPage)
  if (!first) {
    throw new Error('Initial terminal tab is missing')
  }
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneIdentitySnapshot(orcaPage, 2)
  const initialLeaves = await readTerminalPaneDomLeafOrder(orcaPage)
  await selectPane(orcaPage, first, initialLeaves[0])
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneIdentitySnapshot(orcaPage, 3)
  const firstLeaves = await readTerminalPaneDomLeafOrder(orcaPage)

  const second = await addTerminalTab(orcaPage)
  await waitForPaneIdentitySnapshot(orcaPage, 1)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneIdentitySnapshot(orcaPage, 2)
  const secondLeaves = await readTerminalPaneDomLeafOrder(orcaPage)

  await selectPane(orcaPage, first, firstLeaves[0])
  for (const leafId of firstLeaves.slice(1)) {
    await orcaPage.keyboard.press(`${modifier}+Alt+ArrowRight`)
    await expect(paneInput(orcaPage, first, leafId)).toBeFocused()
    await expect(tab(orcaPage, first)).toHaveAttribute('data-active', 'true')
  }

  await testInfo.attach('at-tab-boundary', {
    body: await orcaPage.screenshot({
      mask: [orcaPage.locator('.xterm-screen')],
      maskColor: '#d0d0d0'
    }),
    contentType: 'image/png'
  })
  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowRight`)
  await expect
    .poll(() =>
      orcaPage.evaluate(() =>
        document.activeElement?.closest('[data-leaf-id]')?.getAttribute('data-leaf-id')
      )
    )
    .not.toBe(firstLeaves.at(-1))
  await testInfo.attach('boundary-result', {
    body: await orcaPage.screenshot({
      mask: [orcaPage.locator('.xterm-screen')],
      maskColor: '#d0d0d0'
    }),
    contentType: 'image/png'
  })
  await expect(tab(orcaPage, second)).toHaveAttribute('data-active', 'true')
  await expect(paneInput(orcaPage, second, secondLeaves[0])).toBeFocused()

  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowLeft`)
  await expect(paneInput(orcaPage, first, firstLeaves.at(-1)!)).toBeFocused()
  await expect(tab(orcaPage, first)).toHaveAttribute('data-active', 'true')

  await selectPane(orcaPage, second, secondLeaves.at(-1)!)
  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowRight`)
  await expect(paneInput(orcaPage, first, firstLeaves[0])).toBeFocused()
  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowLeft`)
  await expect(paneInput(orcaPage, second, secondLeaves.at(-1)!)).toBeFocused()
})

test('crosses single-pane tabs without requiring a split', async ({ orcaPage }) => {
  const first = await getActiveTabId(orcaPage)
  if (!first) {
    throw new Error('Initial terminal tab is missing')
  }
  await waitForPaneIdentitySnapshot(orcaPage, 1)
  const firstLeaves = await readTerminalPaneDomLeafOrder(orcaPage)
  const second = await addTerminalTab(orcaPage)
  await waitForPaneIdentitySnapshot(orcaPage, 1)
  const secondLeaves = await readTerminalPaneDomLeafOrder(orcaPage)
  await selectPane(orcaPage, first, firstLeaves[0])
  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowRight`)
  await expect(paneInput(orcaPage, second, secondLeaves[0])).toBeFocused()
  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowLeft`)
  await expect(paneInput(orcaPage, first, firstLeaves[0])).toBeFocused()
})

test('reveals the first pane when the destination tab has its last pane expanded', async ({
  orcaPage
}) => {
  const first = await getActiveTabId(orcaPage)
  if (!first) {
    throw new Error('Initial terminal tab is missing')
  }
  await waitForPaneIdentitySnapshot(orcaPage, 1)
  const firstLeaves = await readTerminalPaneDomLeafOrder(orcaPage)
  const second = await addTerminalTab(orcaPage)
  await waitForPaneIdentitySnapshot(orcaPage, 1)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneIdentitySnapshot(orcaPage, 2)
  const secondLeaves = await readTerminalPaneDomLeafOrder(orcaPage)
  await selectPane(orcaPage, second, secondLeaves.at(-1)!)
  await orcaPage.keyboard.press(`${modifier}+Shift+Enter`)
  const firstPane = orcaPage
    .locator(`[data-terminal-tab-id="${second}"] [data-leaf-id="${secondLeaves[0]}"]`)
    .first()
  await expect(firstPane).not.toBeVisible()
  await selectPane(orcaPage, first, firstLeaves[0])
  await orcaPage.keyboard.press(`${modifier}+Alt+ArrowRight`)
  await expect(firstPane).toBeVisible()
  await expect(paneInput(orcaPage, second, secondLeaves[0])).toBeFocused()
})
