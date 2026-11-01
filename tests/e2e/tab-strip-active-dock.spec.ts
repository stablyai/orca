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

  for (const edge of ['start', 'end'] as const) {
    test(`keeps inactive tabs clickable in a strip too narrow for the ${edge} dock`, async ({
      orcaPage
    }) => {
      const worktreeId = await waitForActiveWorktree(orcaPage)
      for (let i = 0; i < 3; i++) {
        await createBackgroundTerminalTab(orcaPage, worktreeId)
      }
      const ids = await readStripSlotIds(orcaPage)
      const activeTabId = (edge === 'start' ? ids.at(0) : ids.at(-1))!
      const inactiveTabId = (edge === 'start' ? ids.at(-1) : ids.at(0))!
      const activeTab = orcaPage.locator(
        `${slotSelector(activeTabId)} [data-testid="sortable-tab"]`
      )
      const inactiveTab = orcaPage.locator(
        `${slotSelector(inactiveTabId)} [data-testid="sortable-tab"]`
      )
      await activeTab.click()

      const strip = orcaPage.locator(STRIP).first()
      await strip.evaluate((el) => {
        el.style.maxWidth = '200px'
      })
      await expect(strip).toHaveAttribute('data-active-tab-dock-disabled', '')
      await strip.evaluate((el, side) => {
        el.scrollLeft = side === 'start' ? el.scrollWidth : 0
      }, edge)
      await expect.poll(() => isSlotInView(orcaPage, inactiveTabId)).toBe(true)
      await inactiveTab.click()
      await expect(inactiveTab).toHaveAttribute('data-active', 'true')
      await activeTab.locator('[data-tab-close-button]').click()
      await expect(activeTab).toHaveCount(0)

      await strip.evaluate((el) => {
        el.style.maxWidth = '400px'
      })
      await expect(strip).not.toHaveAttribute('data-active-tab-dock-disabled')
      await strip.evaluate((el, side) => {
        el.scrollLeft = side === 'start' ? 0 : el.scrollWidth
      }, edge)
      await expect(strip).toHaveAttribute(
        'data-active-tab-docked',
        edge === 'start' ? 'end' : 'start'
      )
      expect(await isSlotInView(orcaPage, inactiveTabId)).toBe(true)
    })
  }

  test('keeps inactive tabs clickable after cancelling a drag that scrolled a narrow strip', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    for (let i = 0; i < 3; i++) {
      await createBackgroundTerminalTab(orcaPage, worktreeId)
    }
    const ids = await readStripSlotIds(orcaPage)
    const activeSlot = orcaPage.locator(slotSelector(ids[0]))
    const activeTab = activeSlot.locator('[data-testid="sortable-tab"]')
    const inactiveTab = orcaPage.locator(`${slotSelector(ids[1])} [data-testid="sortable-tab"]`)
    await activeTab.click()

    const strip = orcaPage.locator(STRIP).first()
    await strip.evaluate((el) => {
      el.style.maxWidth = '200px'
    })
    await expect(strip).toHaveAttribute('data-active-tab-dock-disabled', '')
    await strip.evaluate((el) => {
      el.scrollLeft = 0
    })
    await expect.poll(() => isSlotInView(orcaPage, ids[0])).toBe(true)

    const box = (await activeTab.boundingBox())!
    const y = box.y + box.height / 2
    await orcaPage.mouse.move(box.x + 20, y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(box.x + 34, y)
    await orcaPage.mouse.move(box.x + 38, y)
    await expect(strip.locator('[data-active-tab-dock]')).toHaveCount(0)

    // Hidden-window drag overlays can intercept native wheel input before it reaches the strip.
    await strip.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 144, cancelable: true }))
    })
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(144)
    await nextFrames(orcaPage, 2)
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('blur')))
    await orcaPage.mouse.up()

    await expect(activeSlot).toHaveAttribute('data-active-tab-dock', '')
    await expect(strip).toHaveAttribute('data-active-tab-dock-disabled', '')
    await inactiveTab.click()
    await expect(inactiveTab).toHaveAttribute('data-active', 'true')
  })

  test('uses consistent single-tab chrome and stable slots through renames and tab-count changes', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await expect(orcaPage.locator(`${STRIP} > [data-tab-strip-slot]`)).toHaveCount(1)
    const [id] = await readStripSlotIds(orcaPage)
    const slot = orcaPage.locator(slotSelector(id))
    const strip = orcaPage.locator(STRIP).first()
    const tab = slot.locator('[data-testid="sortable-tab"]')
    const geometry = () =>
      slot.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const close = element.querySelector('[data-tab-close-button]')!.getBoundingClientRect()
        return [rect.x, rect.width, close.x]
      })
    await expect.poll(() => strip.evaluate((el) => el.clientWidth)).toBeGreaterThan(220)
    const single = await geometry()
    expect(single[1]).toBeGreaterThan(220)
    await expect(tab).toHaveCSS('border-top-width', '1px')
    await expect(strip).toHaveCSS('border-right-width', '1px')
    await expect(tab.locator('.bg-tab-active-indicator')).toBeHidden()
    const singleBackground = await tab.evaluate((el) => getComputedStyle(el).backgroundColor)
    const setTitle = (title: string) =>
      orcaPage.evaluate(
        ({ id, title }) => {
          window.__store!.getState().setTabCustomTitle(id, title, { recordInteraction: false })
        },
        { id, title }
      )
    for (const title of [
      'Notes',
      'Investigate why generated titles move neighboring tabs'.repeat(4)
    ]) {
      await setTitle(title)
      await expect(tab).toContainText(title)
      expect(await geometry()).toEqual(single)
    }
    const added = await createBackgroundTerminalTab(orcaPage, worktreeId)
    await expect(strip.locator('[data-tab-strip-slot]')).toHaveCount(2)
    const multi = await geometry()
    await expect(tab).toHaveCSS('background-color', singleBackground)
    await expect(tab.locator('.bg-tab-active-indicator')).toBeVisible()
    const stripWidth = await strip.evaluate((el) => el.clientWidth)
    expect(multi[1]).toBeCloseTo(stripWidth / 2, 0)
    const addedWidth = await orcaPage
      .locator(slotSelector(added))
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(addedWidth).toBeCloseTo(multi[1], 0)
    expect(stripWidth).toBeGreaterThanOrEqual(single[1] - 2)
    await setTitle('Short')
    await expect(tab).toContainText('Short')
    expect(await geometry()).toEqual(multi)
    await tab.dblclick()
    const input = slot.locator('[data-tab-rename-input]')
    await expect(input).toBeVisible()
    // Close is hidden during editing; the slot itself must keep its width.
    expect(await slot.evaluate((el) => el.getBoundingClientRect().width)).toBe(multi[1])
    await input.press('Escape')
    expect(await geometry()).toEqual(multi)
    await orcaPage.locator(`${slotSelector(added)} [data-tab-close-button]`).click()
    await expect(strip.locator('[data-tab-strip-slot]')).toHaveCount(1)
    await expect.poll(geometry).toEqual(single)
    await expect(tab.locator('.bg-tab-active-indicator')).toBeHidden()
  })

  test('holds browser tab geometry when audio controls appear and disappear', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const browser = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const tab = state.createBrowserTab(worktreeId, 'about:blank', {
        activate: false
      })
      state.createTab(worktreeId, undefined, undefined, { activate: false })
      if (!tab.activePageId) {
        throw new Error('Expected created browser tab to have an active page')
      }
      return { id: tab.id, pageId: tab.activePageId }
    }, worktreeId)
    const slot = orcaPage.locator(slotSelector(browser.id))
    await expect(slot).toContainText('New Tab')
    const geometry = (): Promise<number[][]> =>
      orcaPage.$$eval(`${STRIP} > [data-tab-strip-slot]`, (slots) =>
        slots.map((slot) => {
          const rect = slot.getBoundingClientRect()
          return [rect.x, rect.width]
        })
      )
    await slot.hover()
    const before = await geometry()
    for (const audible of [true, false]) {
      await orcaPage.evaluate(
        ({ pageId, audible }) => {
          window.__store!.getState().setBrowserPageAudible(pageId, audible)
        },
        { pageId: browser.pageId, audible }
      )
      await expect(slot.getByRole('button', { name: 'Mute Tab', exact: true })).toHaveCount(
        audible ? 1 : 0
      )
      await nextFrames(orcaPage, 2)
      expect(await geometry()).toEqual(before)
    }
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
