import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

// Assert real pane geometry: jsdom cannot detect group bodies and anchored panes collapsing to zero height.

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.
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

async function seedFloatingSimulatorTabs(page: Page, count = 2): Promise<E2EUnifiedTab[]> {
  const tabs = await page.evaluate(
    ({ worktreeId, count }) => {
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
      while (existing.length < count) {
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
    },
    { worktreeId: FLOATING_WORKTREE_ID, count }
  )
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

  // The anchored emulator overlay must own the group body’s real pixels.
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

  // Focusing either group must keep its tab reachable in the titlebar.
  await expect(openPanel.locator(`[data-tab-id="${second.id}"]`)).toBeVisible()
  const firstBody = openPanel.locator(`[data-tab-group-body-id="${first.groupId}"]`)
  const firstBodyBox = await firstBody.boundingBox()
  expect(firstBodyBox).not.toBeNull()
  // Click body coordinates because its anchored overlay owns the same focus-group pointer handler.
  await orcaPage.mouse.click(firstBodyBox!.x + 20, firstBodyBox!.y + 20)
  await expect(openPanel.locator(`[data-tab-id="${first.id}"]`)).toBeVisible()
})

test('tabs use spare room for titles, share crowded space, and scroll at the minimum', async ({
  orcaPage
}) => {
  const titles = [
    'A very long conversation title '.repeat(12),
    'Go',
    'Another long conversation title '.repeat(3)
  ]
  const seedFloatingTerminalTabs = (count: number): Promise<string[]> =>
    orcaPage.evaluate(
      ({ count, titles, worktreeId }) => {
        const store = window.__store!
        store.setState((state) => ({
          settings: {
            ...state.settings!,
            floatingTerminalEnabled: true,
            experimentalFitTabsToTitles: true
          }
        }))
        const tabs = [...(store.getState().tabsByWorktree[worktreeId] ?? [])]
        while (tabs.length < count) {
          const tab = store
            .getState()
            .createTab(worktreeId, undefined, undefined, { activate: false })
          store
            .getState()
            .setTabCustomTitle(tab.id, titles[tabs.length] ?? `Tab ${tabs.length + 1}`)
          tabs.push(tab)
        }
        store.getState().setActiveTabForWorktree(worktreeId, tabs[0].id)
        store.getState().activateTab(tabs[0].id)
        return tabs.map((tab) => tab.id)
      },
      { count, titles, worktreeId: FLOATING_WORKTREE_ID }
    )
  const [first] = await seedFloatingTerminalTabs(1)
  await openFloatingPanel(orcaPage)
  const panel = orcaPage.locator(OPEN_PANEL_SELECTOR).first()
  await panel.evaluate((element) => {
    element.style.maxWidth = '720px'
  })
  const firstSlot = panel.locator(`[data-tab-strip-slot="${first}"]`)
  const width = (): Promise<number> =>
    firstSlot.evaluate((element) => element.getBoundingClientRect().width)
  await expect.poll(width).toBeGreaterThan(384)
  const singleWidth = await width()
  const strip = panel.locator('.terminal-tab-strip').first()

  const [, second] = await seedFloatingTerminalTabs(2)
  await expect(panel.locator(`[data-tab-strip-slot="${second}"]`)).toContainText('Go')
  await expect.poll(width).toBeCloseTo(singleWidth - 100, 0)

  const [, , third] = await seedFloatingTerminalTabs(3)
  await expect(panel.locator(`[data-tab-strip-slot="${third}"]`)).toContainText(
    'Another long conversation title'
  )
  await expect
    .poll(() => strip.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(false)
  const widths = (): Promise<number[]> =>
    panel
      .locator('[data-tab-strip-slot]')
      .evaluateAll((slots) => slots.map((element) => element.getBoundingClientRect().width))
  const crowdedWidths = await widths()
  expect(crowdedWidths.every((value) => value >= 100)).toBe(true)
  expect(crowdedWidths[0]).toBeCloseTo(crowdedWidths[2], 0)
  expect(crowdedWidths[1]).toBe(100)

  await seedFloatingTerminalTabs(6)
  await expect(panel.locator('[data-tab-strip-slot]')).toHaveCount(6)
  await expect
    .poll(() => strip.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true)
  expect(await widths()).toEqual([100, 100, 100, 100, 100, 100])
})

// Real pointer capture requires the isolated visible-window project.
test('@headful floating header keeps a drag and maximize target with expanded and overflowing tabs', async ({
  orcaPage
}) => {
  // Cover the shipped fixed widths and the title-fit experiment once the strip overflows.
  for (const { count, fitTitles } of [
    { count: 1, fitTitles: true },
    { count: 16, fitTitles: false },
    { count: 16, fitTitles: true }
  ]) {
    await orcaPage.evaluate((fitTitles) => {
      window.__store!.setState((state) => ({
        settings: { ...state.settings!, experimentalFitTabsToTitles: fitTitles }
      }))
    }, fitTitles)
    await seedFloatingSimulatorTabs(orcaPage, count)
    await openFloatingPanel(orcaPage)

    const panel = orcaPage.locator(OPEN_PANEL_SELECTOR).first()
    const handle = panel.locator('[data-floating-terminal-drag-handle]')
    const strip = panel.locator('.terminal-tab-strip').first()
    await expect
      .poll(() => strip.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(count > 1)

    const before = await panel.boundingBox()
    const grab = await handle.boundingBox()
    expect(before).not.toBeNull()
    expect(grab).not.toBeNull()
    expect(grab!.width).toBeGreaterThanOrEqual(48)
    expect(grab!.height).toBeGreaterThanOrEqual(28)

    const x = grab!.x + grab!.width / 2
    const y = grab!.y + grab!.height / 2
    await orcaPage.mouse.move(x, y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(x - 40, y + 24, { steps: 4 })
    await orcaPage.mouse.up()
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().x))
      .toBeCloseTo(before!.x - 40, 0)
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().y))
      .toBeCloseTo(before!.y + 24, 0)

    await handle.dblclick()
    await expect(panel.getByRole('button', { name: 'Restore floating workspace' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await handle.dblclick()
    await expect(
      panel.getByRole('button', { name: 'Maximize floating workspace' })
    ).toHaveAttribute('aria-pressed', 'false')
    expect(await orcaPage.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true)
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().x))
      .toBeCloseTo(before!.x - 40, 0)
  }
})
