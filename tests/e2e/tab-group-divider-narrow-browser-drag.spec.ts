// A divider beside a narrow browser group must stay grabbable along its whole height and follow a
// mouse drag whose first move lands on the page; otherwise the <webview> takes the gesture.

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createTerminalBrowserSplit,
  waitForBrowserGuestRegistration
} from './helpers/browser-split-fixture'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './helpers/browser-split-page-server'

const DIVIDER = '.tab-group-split-resize-handle.is-vertical'

type Point = { x: number; y: number }

/** Centre of the divider between the browser group and the group to its right. */
async function browserRightDividerCenter(page: Page, browserGroupId: string): Promise<Point> {
  return page.evaluate(
    ({ groupId, selector }) => {
      const body = document.querySelector<HTMLElement>(`[data-tab-group-body-id="${groupId}"]`)
      const bodyRight = body!.getBoundingClientRect().right
      const handle = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => Math.abs(candidate.getBoundingClientRect().left - bodyRight) < 2
      )
      const rect = handle!.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    },
    { groupId: browserGroupId, selector: DIVIDER }
  )
}

/** Points down the divider's centre line that something other than the divider receives. */
async function coveredDividerPoints(page: Page, browserGroupId: string): Promise<string[]> {
  const { x } = await browserRightDividerCenter(page, browserGroupId)
  return page.evaluate(
    ({ centerX, selector }) => {
      const handle = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.left <= centerX && centerX <= rect.right
        }
      )!
      const rect = handle.getBoundingClientRect()
      const covered: string[] = []
      for (let y = rect.top + 2; y < rect.bottom - 2; y += 4) {
        const hit = document.elementFromPoint(centerX, y)
        if (hit !== handle) {
          covered.push(`y=${Math.round(y)} ${hit?.tagName.toLowerCase()}`)
        }
      }
      return covered
    },
    { centerX: x, selector: DIVIDER }
  )
}

function groupWidth(page: Page, groupId: string): Promise<number> {
  return page.evaluate(
    (id) =>
      document
        .querySelector<HTMLElement>(`[data-tab-group-body-id="${id}"]`)!
        .getBoundingClientRect().width,
    groupId
  )
}

function hitTag(page: Page, point: Point): Promise<string | undefined> {
  return page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), point)
}

async function dragDivider(page: Page, from: Point, firstMove: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(firstMove.x, firstMove.y)
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
}

test.describe('tab-group divider beside a narrow browser group', () => {
  let server: BrowserSplitPageServer

  test.beforeEach(async ({ orcaPage }) => {
    server = await startBrowserSplitPageServer()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async () => {
    await server.close()
  })

  test('tracks a drag that crosses the browser page and stays grabbable', async ({ orcaPage }) => {
    // The sidebars leave a narrow row of groups, as in the report: terminal | browser | terminal.
    await orcaPage.setViewportSize({ width: 900, height: 700 })
    const fixture = await createTerminalBrowserSplit(orcaPage, server.pageUrl('narrow', 1))
    await waitForBrowserGuestRegistration(orcaPage, fixture.browserTabId, fixture.browserPageId)
    await orcaPage.evaluate(({ browserGroupId }) => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      const groupId = state.createEmptySplitGroup(worktreeId, browserGroupId, 'right')
      if (!groupId) {
        throw new Error('Third group unavailable')
      }
      state.createTab(worktreeId, groupId)
    }, fixture)
    await expect(orcaPage.locator(DIVIDER)).toHaveCount(2)

    // Widen the browser group: its toolbar must stay inside the group, off the divider.
    const start = await browserRightDividerCenter(orcaPage, fixture.browserGroupId)
    const narrowWidth = await groupWidth(orcaPage, fixture.browserGroupId)
    await dragDivider(
      orcaPage,
      start,
      { x: start.x + 4, y: start.y },
      { x: start.x + 120, y: start.y }
    )
    await expect(orcaPage.locator(`${DIVIDER}.is-dragging`)).toHaveCount(0)
    await expect
      .poll(() => groupWidth(orcaPage, fixture.browserGroupId))
      .toBeGreaterThan(narrowWidth + 40)
    expect(await coveredDividerPoints(orcaPage, fixture.browserGroupId)).toEqual([])

    // Drag back toward the browser with the first move already on the page.
    const wideWidth = await groupWidth(orcaPage, fixture.browserGroupId)
    const divider = await browserRightDividerCenter(orcaPage, fixture.browserGroupId)
    const onPage = { x: divider.x - 12, y: divider.y }
    expect(await hitTag(orcaPage, onPage)).toBe('webview')
    await dragDivider(orcaPage, divider, onPage, { x: divider.x - 60, y: divider.y })

    await expect(orcaPage.locator(`${DIVIDER}.is-dragging`)).toHaveCount(0)
    await expect
      .poll(() => groupWidth(orcaPage, fixture.browserGroupId))
      .toBeLessThan(wideWidth - 30)

    // A lost gesture would keep owning the divider and ignore the next press.
    const shrunkWidth = await groupWidth(orcaPage, fixture.browserGroupId)
    const again = await browserRightDividerCenter(orcaPage, fixture.browserGroupId)
    await dragDivider(
      orcaPage,
      again,
      { x: again.x + 4, y: again.y },
      { x: again.x + 40, y: again.y }
    )
    await expect(orcaPage.locator(`${DIVIDER}.is-dragging`)).toHaveCount(0)
    await expect
      .poll(() => groupWidth(orcaPage, fixture.browserGroupId))
      .toBeGreaterThan(shrunkWidth + 20)
  })

  test('keeps a narrow browser toolbar from scrolling when a clipped control takes focus', async ({
    orcaPage
  }) => {
    await orcaPage.setViewportSize({ width: 1000, height: 700 })
    const fixture = await createTerminalBrowserSplit(orcaPage, server.pageUrl('clip', 1))
    await waitForBrowserGuestRegistration(orcaPage, fixture.browserTabId, fixture.browserPageId)
    // Size the browser group to about 150px, narrower than its toolbar.
    await orcaPage.evaluate(({ terminalGroupId, browserGroupId }) => {
      const width = (id: string): number =>
        document
          .querySelector<HTMLElement>(`[data-tab-group-body-id="${id}"]`)!
          .getBoundingClientRect().width
      const row = width(terminalGroupId) + width(browserGroupId)
      const state = window.__store!.getState()
      state.setTabGroupSplitRatio(state.activeWorktreeId!, '', 1 - 150 / row)
    }, fixture)
    await expect.poll(() => groupWidth(orcaPage, fixture.browserGroupId)).toBeLessThan(160)

    const overlay = orcaPage.locator(`[data-browser-overlay-tab-id="${fixture.browserTabId}"]`)
    const menu = overlay.getByRole('button', { name: 'Browser menu' })
    await overlay.getByRole('button', { name: 'Reload' }).focus()
    await expect(async () => {
      await orcaPage.keyboard.press('Tab')
      await expect(menu).toBeFocused({ timeout: 200 })
    }).toPass({ timeout: 10_000 })

    // Nothing between the focused control and the document may scroll sideways to reveal it.
    const scrolled = await menu.evaluate((button) => {
      const offsets: string[] = []
      for (let node: Element | null = button; node; node = node.parentElement) {
        if (node.scrollLeft !== 0) {
          offsets.push(
            `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}=${node.scrollLeft}`
          )
        }
      }
      return offsets
    })
    expect(scrolled).toEqual([])
  })
})
