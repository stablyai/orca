import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

// Why this spec exists: the floating panel once rendered the shared group tree in a block
// container, so every group body — and every pane anchored to one — measured 0px tall while
// the whole unit suite stayed green (jsdom computes no layout). Only a real renderer can
// assert that a pane owns actual pixels, so the pin lives here.

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// E2E specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'
const OPEN_PANEL_SELECTOR = `${PANEL_SELECTOR}[aria-hidden="false"]`
const GROUP_BODY_SELECTOR = '[data-tab-group-body-id]'
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'
// The default panel is 560px tall with a 36px titlebar; anything near zero is the regression.
const MIN_PANE_EDGE_PX = 100

type E2EUnifiedTab = {
  id: string
  contentType: string
  groupId: string
}

type E2EStoreState = {
  settings: Record<string, unknown>
  unifiedTabsByWorktree: Record<string, E2EUnifiedTab[] | undefined>
  createUnifiedTab: (
    worktreeId: string,
    contentType: 'simulator',
    init: { label: string; recordInteraction: false }
  ) => E2EUnifiedTab
  activateTab: (tabId: string) => void
  dropUnifiedTab: (
    tabId: string,
    target: { groupId: string; splitDirection?: 'left' | 'right' | 'up' | 'down' }
  ) => boolean
}

type E2EStore = {
  getState: () => E2EStoreState
  setState: (partial: Partial<E2EStoreState>) => void
}

type E2EWindow = typeof window & {
  __store?: E2EStore
}

async function seedFloatingSimulatorTabs(page: Page): Promise<E2EUnifiedTab[]> {
  const tabs = await page.evaluate((worktreeId) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `__store` is the dev/e2e store handle Orca injects on window; the cast only names it.
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
    const refreshed = store.getState()
    const existing = (refreshed.unifiedTabsByWorktree[worktreeId] ?? []).filter(
      (tab) => tab.contentType === 'simulator'
    )
    while (existing.length < 2) {
      existing.push(
        refreshed.createUnifiedTab(worktreeId, 'simulator', {
          label: `Mobile Emulator ${existing.length + 1}`,
          recordInteraction: false
        })
      )
    }
    refreshed.activateTab(existing[0].id)
    return existing.map((tab) => ({
      id: tab.id,
      contentType: tab.contentType,
      groupId: tab.groupId
    }))
  }, FLOATING_WORKTREE_ID)
  await page.waitForFunction(
    (panelSelector) => Boolean(document.querySelector(panelSelector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
  return tabs
}

async function openFloatingPanel(page: Page): Promise<void> {
  if ((await page.locator(OPEN_PANEL_SELECTOR).count()) === 0) {
    await page.evaluate((eventName) => {
      window.dispatchEvent(new Event(eventName))
    }, TOGGLE_EVENT)
  }
  await expect(page.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
}

test('floating panel group bodies and panes own real pixels, single group and split', async ({
  orcaPage
}) => {
  const [first, second] = await seedFloatingSimulatorTabs(orcaPage)
  await openFloatingPanel(orcaPage)

  const openPanel = orcaPage.locator(OPEN_PANEL_SELECTOR).first()
  const soleBody = openPanel.locator(GROUP_BODY_SELECTOR)
  await expect(soleBody).toHaveCount(1)
  const soleBox = await soleBody.boundingBox()
  expect(soleBox, 'single group body must have a box').not.toBeNull()
  expect(soleBox!.height, 'single group body height').toBeGreaterThan(MIN_PANE_EDGE_PX)
  expect(soleBox!.width, 'single group body width').toBeGreaterThan(MIN_PANE_EDGE_PX)

  // The emulator pane overlay anchors to the group body; it must cover the same rect,
  // not sit at 0px like the regression this spec pins.
  const paneBox = await openPanel.locator('[data-emulator-pane]:visible').first().boundingBox()
  expect(paneBox, 'anchored pane must have a box').not.toBeNull()
  expect(paneBox!.height).toBeGreaterThan(MIN_PANE_EDGE_PX)

  // Move Tab to Split → Right (the context-menu path dispatches this same store action).
  const moved = await orcaPage.evaluate(
    ({ tabId, groupId }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `__store` is the dev/e2e store handle Orca injects on window; the cast only names it.
      const store = (window as E2EWindow).__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      return store.getState().dropUnifiedTab(tabId, { groupId, splitDirection: 'right' })
    },
    { tabId: second.id, groupId: second.groupId }
  )
  expect(moved, 'split move must be accepted by the store').toBe(true)

  const splitBodies = openPanel.locator(GROUP_BODY_SELECTOR)
  await expect(splitBodies).toHaveCount(2)
  for (const body of await splitBodies.all()) {
    const box = await body.boundingBox()
    expect(box, 'each split group body must have a box').not.toBeNull()
    expect(box!.height, 'split group body height').toBeGreaterThan(MIN_PANE_EDGE_PX)
    expect(box!.width, 'split group body width').toBeGreaterThan(MIN_PANE_EDGE_PX)
  }

  // Both tabs stay reachable: the moved tab's pane is on screen, and focusing the other
  // pane brings the original group's tab back into the titlebar strip.
  await expect(openPanel.locator(`[data-tab-id="${second.id}"]`)).toBeVisible()
  const firstBody = openPanel.locator(`[data-tab-group-body-id="${first.groupId}"]`)
  const firstBodyBox = await firstBody.boundingBox()
  expect(firstBodyBox).not.toBeNull()
  // Raw mouse click: the anchored pane overlay covers the body and owns the same
  // focus-the-group pointerdown, so click whatever is topmost at the body's coords.
  await orcaPage.mouse.click(firstBodyBox!.x + 20, firstBodyBox!.y + 20)
  await expect(openPanel.locator(`[data-tab-id="${first.id}"]`)).toBeVisible()
})
