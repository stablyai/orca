// Require real Chromium sticky layout to dock an overflowed active tab and reveal arrivals without scrolling/flicker; mocked unit geometry cannot prove the drawn dock.

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'

const STRIP = '.terminal-tab-strip'

type DockSample = { scrollLeft: number; activeLeft: number; activeRight: number }

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __tabStripDockSamples?: DockSample[]
  }
}

function slotSelector(tabId: string): string {
  return `${STRIP} > [data-tab-strip-slot="${tabId}"]`
}

async function createBackgroundTerminalTab(page: Page, worktreeId: string): Promise<string> {
  return page.evaluate(
    (wId) =>
      window.__store!.getState().createTab(wId, undefined, undefined, { activate: false }).id,
    worktreeId
  )
}

async function readStripSlotIds(page: Page): Promise<string[]> {
  return page.$$eval(`${STRIP} > [data-tab-strip-slot]`, (nodes) =>
    nodes.map((node) => node.getAttribute('data-tab-strip-slot') ?? '')
  )
}

/** Where `tabId` is drawn relative to the strip's visible viewport, in px. */
async function readSlotViewportSpan(
  page: Page,
  tabId: string
): Promise<{ left: number; right: number; viewLeft: number; viewRight: number }> {
  return page.evaluate(
    ({ strip, slot }) => {
      const stripEl = document.querySelector<HTMLElement>(strip)!
      const slotRect = document.querySelector<HTMLElement>(slot)!.getBoundingClientRect()
      const viewLeft = stripEl.getBoundingClientRect().left + stripEl.clientLeft
      return {
        left: slotRect.left,
        right: slotRect.right,
        viewLeft,
        viewRight: viewLeft + stripEl.clientWidth
      }
    },
    { strip: STRIP, slot: slotSelector(tabId) }
  )
}

async function isSlotInView(page: Page, tabId: string): Promise<boolean> {
  const span = await readSlotViewportSpan(page, tabId)
  return span.left >= span.viewLeft - 1 && span.right <= span.viewRight + 1
}

async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) {
      await new Promise(requestAnimationFrame)
    }
  }, count)
}

test.describe('Tab strip active-tab dock', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('fits titles without resizing neighbors when tabs open and close in spare space', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const tabIds = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const short = state.createTab(worktreeId, undefined, undefined, { activate: false })
      const long = state.createTab(worktreeId, undefined, undefined, { activate: false })
      state.setTabCustomTitle(short.id, 'Terminal 1')
      state.setTabCustomTitle(
        long.id,
        'Measure the effect of the new tab layout on conversation navigation'
      )
      return { short: short.id, long: long.id }
    }, worktreeId)
    const short = orcaPage.locator(slotSelector(tabIds.short))
    const long = orcaPage.locator(slotSelector(tabIds.long))
    const width = (tab: typeof short): Promise<number> =>
      tab.evaluate((element) => element.getBoundingClientRect().width)

    await expect(short).toContainText('Terminal 1')
    await expect(long).toContainText(
      'Measure the effect of the new tab layout on conversation navigation'
    )
    expect(await width(short)).toBeLessThan(140)
    expect(await width(long)).toBeGreaterThan(384)
    const label = long.locator('span.truncate')
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const geometry = (): Promise<number[][]> =>
      orcaPage.evaluate(
        (ids) =>
          ids.map((id) => {
            const slot = document.querySelector(`[data-tab-strip-slot="${id}"]`)!
            const tab = slot.getBoundingClientRect()
            const close = slot.querySelector('[data-tab-close-button]')!.getBoundingClientRect()
            return [tab.x, close.x]
          }),
        [tabIds.short, tabIds.long]
      )
    const before = await geometry()
    const added = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { activate: false })
      state.setTabCustomTitle(tab.id, 'Go')
      return tab.id
    }, worktreeId)
    await expect(orcaPage.locator(slotSelector(added))).toContainText('Go')
    for (let frame = 0; frame < 4; frame++) {
      await nextFrames(orcaPage, 1)
      expect(await geometry()).toEqual(before)
    }
    await long.locator('[data-testid="sortable-tab"]').click()
    await expect(long.locator('[data-active="true"]')).toHaveCount(1)
    expect(await geometry()).toEqual(before)
    await orcaPage.locator(`${slotSelector(added)} [data-tab-close-button]`).click()
    await expect(orcaPage.locator(slotSelector(added))).toHaveCount(0)
    for (let frame = 0; frame < 4; frame++) {
      await nextFrames(orcaPage, 1)
      expect(await geometry()).toEqual(before)
    }

    await orcaPage.evaluate(
      ({ id }) => {
        window.__store!.getState().setTabCustomTitle(id, 'Chat')
      },
      { id: tabIds.long }
    )
    await expect(long).toContainText('Chat')
    await expect.poll(() => width(long)).toBeLessThanOrEqual(100)

    await orcaPage.evaluate(
      ({ id }) => {
        window
          .__store!.getState()
          .setTabCustomTitle(id, 'A very long conversation title '.repeat(20))
      },
      { id: tabIds.long }
    )
    await expect(long).toContainText('A very long conversation title')
    await expect.poll(() => width(long)).toBeGreaterThan(384)
    const strip = orcaPage.locator(STRIP).first()
    expect(await strip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const stripBox = await strip.boundingBox()
    const buttonBox = await orcaPage
      .getByRole('button', { name: 'New tab', exact: true })
      .first()
      .boundingBox()
    expect(stripBox).not.toBeNull()
    expect(buttonBox).not.toBeNull()
    expect(buttonBox!.x - stripBox!.x - stripBox!.width).toBeGreaterThanOrEqual(0)
    expect(buttonBox!.x - stripBox!.x - stripBox!.width).toBeLessThanOrEqual(12)
  })

  test('keeps tab and close-button positions stable through agent detection and activity changes', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const ids = await orcaPage.evaluate((worktreeId) => {
      const store = window.__store!
      const agent = store
        .getState()
        .createTab(worktreeId, undefined, undefined, { activate: false })
      const next = store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
      store.getState().setTabCustomTitle(agent.id, 'Agent conversation')
      store.getState().setTabCustomTitle(next.id, 'Neighbor')
      return [agent.id, next.id]
    }, worktreeId)
    const agent = orcaPage.locator(slotSelector(ids[0]))
    await expect(agent.locator('[data-shell-icon]')).toBeVisible()
    await expect(orcaPage.locator(slotSelector(ids[1]))).toContainText('Neighbor')
    const geometry = (): Promise<number[][]> =>
      orcaPage.evaluate(
        (ids) =>
          ids.map((id) => {
            const slot = document.querySelector(`[data-tab-strip-slot="${id}"]`)!
            const tab = slot.getBoundingClientRect()
            const close = slot.querySelector('[data-tab-close-button]')!.getBoundingClientRect()
            return [tab.x, tab.width, close.x]
          }),
        ids
      )
    const before = await geometry()

    for (const stage of ['working', 'unread', 'idle'] as const) {
      await orcaPage.evaluate(
        ({ tabId, worktreeId, stage }) => {
          const store = window.__store!
          const paneKey = `${tabId}:00000000-0000-4000-8000-000000000001`
          store.setState((state) => {
            const agentStatusByPaneKey = { ...state.agentStatusByPaneKey }
            const unreadTerminalTabs = { ...state.unreadTerminalTabs }
            delete agentStatusByPaneKey[paneKey]
            delete unreadTerminalTabs[tabId]
            if (stage === 'working') {
              agentStatusByPaneKey[paneKey] = {
                paneKey,
                worktreeId,
                agentType: 'codex',
                state: 'working',
                prompt: '',
                updatedAt: Date.now(),
                stateStartedAt: Date.now(),
                stateHistory: []
              }
            } else if (stage === 'unread') {
              unreadTerminalTabs[tabId] = true
            }
            return { agentStatusByPaneKey, unreadTerminalTabs }
          })
        },
        { tabId: ids[0], worktreeId, stage }
      )
      await expect(agent.locator('[data-testid="tab-agent-activity-indicator"]')).toHaveCount(
        stage === 'working' ? 1 : 0
      )
      await expect(agent.locator('[data-testid="tab-activity-bell"]')).toHaveCount(
        stage === 'unread' ? 1 : 0
      )
      await expect(agent.locator('[data-agent-icon="codex"]')).toHaveCount(
        stage === 'working' ? 1 : 0
      )
      await expect(agent).toContainText('Agent conversation')
      await expect.poll(geometry).toEqual(before)
    }
  })

  test('docks an offscreen active tab and reveals an arriving tab beside it without flicker', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const strip = orcaPage.locator(STRIP).first()
    await expect(strip).toBeVisible()

    for (let i = 0; i < 40; i++) {
      const overflowsTwice = await strip.evaluate((el) => el.scrollWidth > el.clientWidth * 2)
      if (overflowsTwice) {
        break
      }
      await createBackgroundTerminalTab(orcaPage, worktreeId)
      await nextFrames(orcaPage, 1)
    }
    await expect
      .poll(() => strip.evaluate((el) => el.scrollWidth > el.clientWidth * 2), { timeout: 5_000 })
      .toBe(true)

    const lastTabId = (await readStripSlotIds(orcaPage)).at(-1)!
    await orcaPage.locator(`${slotSelector(lastTabId)} [data-testid="sortable-tab"]`).click()
    await expect(orcaPage.locator(`${slotSelector(lastTabId)} [data-active="true"]`)).toHaveCount(1)

    // Scroll the active last tab's real spot far out of view; sticky layout must hold it at the end.
    await strip.evaluate((el) => {
      el.scrollLeft = 0
    })
    await expect(strip).toHaveAttribute('data-active-tab-docked', 'end')
    const docked = await readSlotViewportSpan(orcaPage, lastTabId)
    expect(Math.abs(docked.right - docked.viewRight)).toBeLessThanOrEqual(1)

    // Why sample every frame: a smooth scroll or a double jump shows up only between assertions.
    await orcaPage.evaluate(
      ({ strip: stripSelector, slot }) => {
        const stripEl = document.querySelector<HTMLElement>(stripSelector)!
        const samples: DockSample[] = []
        const sample = (): void => {
          const rect = document.querySelector<HTMLElement>(slot)!.getBoundingClientRect()
          samples.push({
            scrollLeft: stripEl.scrollLeft,
            activeLeft: rect.left,
            activeRight: rect.right
          })
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        window.__tabStripDockSamples = samples
      },
      { strip: STRIP, slot: slotSelector(lastTabId) }
    )

    // The pointer still rests on the strip from the click, so the arriving tab waits for it to leave.
    const arrivingTabId = await createBackgroundTerminalTab(orcaPage, worktreeId)
    await expect(orcaPage.locator(slotSelector(arrivingTabId))).toHaveCount(1)
    await nextFrames(orcaPage, 3)
    expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0)
    expect(await isSlotInView(orcaPage, arrivingTabId)).toBe(false)

    const stripBox = (await strip.boundingBox())!
    await orcaPage.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height + 200)
    await expect.poll(() => isSlotInView(orcaPage, arrivingTabId), { timeout: 3_000 }).toBe(true)
    expect(await isSlotInView(orcaPage, lastTabId)).toBe(true)
    await nextFrames(orcaPage, 3)

    const finalScrollLeft = await strip.evaluate((el) => el.scrollLeft)
    expect(finalScrollLeft).toBeGreaterThan(0)
    const view = await readSlotViewportSpan(orcaPage, lastTabId)
    const samples = await orcaPage.evaluate(() => window.__tabStripDockSamples ?? [])
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      // One jump from the docked position to the reveal; any value in between is visible scrolling.
      expect([0, finalScrollLeft]).toContain(sample.scrollLeft)
      expect(sample.activeLeft).toBeGreaterThanOrEqual(view.viewLeft - 1)
      expect(sample.activeRight).toBeLessThanOrEqual(view.viewRight + 1)
    }
  })
})
