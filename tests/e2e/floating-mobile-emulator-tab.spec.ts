import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// E2E specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'
const OPEN_PANEL_SELECTOR = `${PANEL_SELECTOR}[aria-hidden="false"]`
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'
const TAB_SELECTOR = '.terminal-tab-strip [data-tab-id]'

type SeededSimulatorTab = {
  id: string
}
type E2ESimulatorTab = {
  id: string
  contentType: string
}

type E2EStoreState = {
  settings: Record<string, unknown>
  unifiedTabsByWorktree: Record<string, E2ESimulatorTab[] | undefined>
  createUnifiedTab: (
    worktreeId: string,
    contentType: 'simulator',
    init: { label: string; recordInteraction: false }
  ) => E2ESimulatorTab
  activateTab: (tabId: string) => void
}

type E2EStore = {
  getState: () => E2EStoreState
  setState: (partial: Partial<E2EStoreState>) => void
}

type E2EWindow = typeof window & {
  __store?: E2EStore
}

async function seedFloatingSimulatorTab(page: Page): Promise<SeededSimulatorTab> {
  const tab = await page.evaluate((worktreeId) => {
    const store = (window as E2EWindow).__store
    if (!store) {
      throw new Error('Store unavailable')
    }

    const state = store.getState()
    store.setState({
      settings: {
        ...state.settings,
        floatingTerminalEnabled: true,
        mobileEmulatorEnabled: true
      }
    })

    const refreshedState = store.getState()
    const existingTab = (refreshedState.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'simulator'
    )
    const tab =
      existingTab ??
      refreshedState.createUnifiedTab(worktreeId, 'simulator', {
        label: 'Mobile Emulator',
        recordInteraction: false
      })
    refreshedState.activateTab(tab.id)
    return { id: tab.id }
  }, FLOATING_WORKTREE_ID)
  // Why: the toggle listener closes over floatingTerminalEnabled; wait for
  // React to commit the enabled floating panel before dispatching the event.
  await page.waitForFunction(
    (panelSelector) => Boolean(document.querySelector(panelSelector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
  return tab
}

async function openFloatingPanelIfNeeded(page: Page): Promise<void> {
  if ((await page.locator(OPEN_PANEL_SELECTOR).count()) === 0) {
    await page.evaluate((eventName) => {
      window.dispatchEvent(new Event(eventName))
    }, TOGGLE_EVENT)
  }
  await expect(page.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
}

async function attachPanelScreenshot(page: Page, testInfo: TestInfo): Promise<void> {
  const panel = page.locator(OPEN_PANEL_SELECTOR).first()
  const body = await panel.screenshot()
  await testInfo.attach('floating-mobile-emulator-open', { body, contentType: 'image/png' })
}

test('floating Mobile Emulator tab renders content and closes from the tab strip', async ({
  orcaPage
}, testInfo) => {
  const tab = await seedFloatingSimulatorTab(orcaPage)
  await openFloatingPanelIfNeeded(orcaPage)

  const openPanel = orcaPage.locator(OPEN_PANEL_SELECTOR).first()
  const tabLocator = openPanel.locator(`[data-tab-id="${tab.id}"]`)
  await expect(tabLocator).toBeVisible()
  await expect(openPanel.locator('[data-emulator-pane]')).toBeVisible()
  await attachPanelScreenshot(orcaPage, testInfo)

  await tabLocator.hover()
  await tabLocator.locator('[data-tab-close-button="true"]').click()

  await expect
    .poll(
      async () =>
        orcaPage.evaluate(
          ({ worktreeId, tabId }) => {
            const tabs =
              (window as E2EWindow).__store?.getState().unifiedTabsByWorktree[worktreeId] ?? []
            return tabs.some((candidate) => candidate.id === tabId)
          },
          { worktreeId: FLOATING_WORKTREE_ID, tabId: tab.id }
        ),
      { timeout: 10_000 }
    )
    .toBe(false)

  await expect(tabLocator).toHaveCount(0)
  await expect(openPanel.locator('[data-emulator-pane]')).toHaveCount(0)
})

test('floating tab drag reorders only the floating tab context', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const firstTab = await seedFloatingSimulatorTab(orcaPage)
  const secondTab = await orcaPage.evaluate((worktreeId) => {
    const store = (window as E2EWindow).__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    return store.getState().createUnifiedTab(worktreeId, 'simulator', {
      label: 'Mobile Emulator 2',
      recordInteraction: false
    })
  }, FLOATING_WORKTREE_ID)
  await openFloatingPanelIfNeeded(orcaPage)

  const openPanel = orcaPage.locator(OPEN_PANEL_SELECTOR).first()
  const mainOrderBefore = await orcaPage
    .locator(TAB_SELECTOR)
    .evaluateAll(
      (nodes, panelSelector) =>
        nodes
          .filter((node) => !node.closest(panelSelector))
          .map((node) => (node as HTMLElement).dataset.tabId ?? ''),
      PANEL_SELECTOR
    )
  const floatingOrderBefore = await openPanel
    .locator(TAB_SELECTOR)
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.tabId ?? ''))
  expect(floatingOrderBefore).toEqual([firstTab.id, secondTab.id])

  const firstBox = await openPanel
    .locator(`${TAB_SELECTOR}[data-tab-id="${firstTab.id}"]`)
    .boundingBox()
  const secondBox = await openPanel
    .locator(`${TAB_SELECTOR}[data-tab-id="${secondTab.id}"]`)
    .boundingBox()
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()

  await orcaPage.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(
    secondBox!.x + secondBox!.width * 0.75,
    secondBox!.y + secondBox!.height / 2,
    {
      steps: 8
    }
  )
  await orcaPage.mouse.up()

  await expect
    .poll(
      () =>
        openPanel
          .locator(TAB_SELECTOR)
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.tabId ?? '')),
      { timeout: 5_000, message: 'Floating tab drag did not reorder the floating tab strip' }
    )
    .toEqual([secondTab.id, firstTab.id])
  await expect
    .poll(() =>
      orcaPage
        .locator(TAB_SELECTOR)
        .evaluateAll(
          (nodes, panelSelector) =>
            nodes
              .filter((node) => !node.closest(panelSelector))
              .map((node) => (node as HTMLElement).dataset.tabId ?? ''),
          PANEL_SELECTOR
        )
    )
    .toEqual(mainOrderBefore)
})
