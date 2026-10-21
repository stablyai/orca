/**
 * E2E test for the overflowing tab strip in real browser layout: the active tab docks to the edge
 * it would scroll past, and a tab arriving off screen is revealed beside it without the strip
 * visibly scrolling or the active tab flickering out of view.
 *
 * Why E2E: the unit tests mock slot geometry, so they assume `position: sticky` clamps the active
 * tab to the viewport. Only Chromium layout proves the dock is actually drawn at the edge.
 */

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
