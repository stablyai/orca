import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// A tab strip scrolls its overflow, but a scrolled-off tab still has a real position on screen:
// over the neighbouring split, or under the strip's own buttons. Drops must follow what is visible.

type Splits = { leftGroupId: string; rightGroupId: string }
type Box = { left: number; right: number; top: number; bottom: number }
type Point = { x: number; y: number }
type StripGeometry = { tabs: { id: string; box: Box }[]; scroller: Box }

const TAB = '[data-testid="sortable-tab"][data-tab-id]'

function stripSelector(groupId: string): string {
  return `[data-tab-group-strip-id="${groupId}"]`
}

function scrollerSelector(groupId: string): string {
  return `${stripSelector(groupId)} .terminal-tab-strip`
}

async function buildSplits(
  page: Page,
  worktreeId: string,
  counts: { left: number; right: number }
): Promise<Splits> {
  const splits = await page.evaluate(
    ({ id, counts }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('window.__store is not available')
      }
      state.setSidebarOpen(false)
      state.setRightSidebarOpen(true)
      const leftGroupId = state.activeGroupIdByWorktree[id] ?? state.groupsByWorktree[id]?.[0]?.id
      if (!leftGroupId) {
        throw new Error('No root tab group')
      }
      const existing = state.groupsByWorktree[id]?.find((g) => g.id === leftGroupId)?.tabOrder
      for (let i = existing?.length ?? 0; i < counts.left; i++) {
        state.createTab(id, leftGroupId, undefined, { activate: false })
      }
      const rightGroupId = state.createEmptySplitGroup(id, leftGroupId, 'right')
      if (!rightGroupId) {
        throw new Error('Right split was not created')
      }
      for (let i = 0; i < counts.right; i++) {
        state.createTab(id, rightGroupId, undefined, { activate: i === counts.right - 1 })
      }
      state.setTabGroupSplitRatio(id, '', 0.5)
      return { leftGroupId, rightGroupId }
    },
    { id: worktreeId, counts }
  )
  await expect.poll(() => stripTabIds(page, splits.leftGroupId)).toHaveLength(counts.left)
  await expect.poll(() => stripTabIds(page, splits.rightGroupId)).toHaveLength(counts.right)
  return splits
}

async function stripTabIds(page: Page, groupId: string): Promise<string[]> {
  return page.$$eval(`${stripSelector(groupId)} ${TAB}`, (nodes) =>
    nodes.map((node) => node.getAttribute('data-tab-id') ?? '')
  )
}

async function scrollStripToEnd(page: Page, groupId: string): Promise<void> {
  const scroller = page.locator(scrollerSelector(groupId))
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeGreaterThan(200)
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
    .toBeLessThanOrEqual(1)
}

/** The screen boxes of a strip's tabs, visible or not, and of its visible scroller. */
async function stripGeometry(page: Page, groupId: string): Promise<StripGeometry> {
  return page.evaluate(
    ({ strip, scroller, tab }) => {
      const toBox = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      }
      return {
        tabs: [...document.querySelectorAll(`${strip} ${tab}`)].map((el) => ({
          id: el.getAttribute('data-tab-id') ?? '',
          box: toBox(el)
        })),
        scroller: toBox(document.querySelector(scroller)!)
      }
    },
    { strip: stripSelector(groupId), scroller: scrollerSelector(groupId), tab: TAB }
  )
}

function containsX(box: Box, x: number): boolean {
  return x > box.left && x < box.right
}

function hiddenTabs(strip: StripGeometry): { id: string; box: Box }[] {
  return strip.tabs.filter(
    ({ box }) => box.right <= strip.scroller.left || box.left >= strip.scroller.right
  )
}

/** Mean distance from a point to a box's corners: how a pointer picks among overlapping boxes. */
function cornerDistance(box: Box, point: Point): number {
  const corners = [
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom]
  ]
  return corners.reduce((sum, [x, y]) => sum + Math.hypot(point.x - x!, point.y - y!), 0) / 4
}

/** Press a tab, pass the drag threshold, then move to the point `target` resolves and drop. */
async function dragTab(
  page: Page,
  groupId: string,
  tabId: string,
  target: () => Promise<Point>
): Promise<void> {
  const box = await page
    .locator(`${stripSelector(groupId)} ${TAB}[data-tab-id="${tabId}"]`)
    .boundingBox()
  if (!box) {
    throw new Error(`Tab ${tabId} has no box`)
  }
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 20, y, { steps: 4 })
  const point = await target()
  await page.mouse.move(point.x, point.y, { steps: 12 })
  await page.mouse.up()
}

function moved(
  order: string[],
  tabId: string,
  targetId: string,
  side: 'before' | 'after'
): string[] {
  const next = order.filter((id) => id !== tabId)
  next.splice(next.indexOf(targetId) + (side === 'after' ? 1 : 0), 0, tabId)
  return next
}

test.describe('tab drops beside a scrolled tab strip', () => {
  test.beforeEach(async ({ orcaPage }) => {
    // Wide enough that each split's strip shows a few tabs beside its own buttons.
    await orcaPage.setViewportSize({ width: 1920, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('reorders within its split when the other split’s scrolled-off tabs lie under the pointer', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const splits = await buildSplits(orcaPage, worktreeId, { left: 4, right: 16 })
    await scrollStripToEnd(orcaPage, splits.rightGroupId)
    const leftBefore = await stripTabIds(orcaPage, splits.leftGroupId)
    const rightBefore = await stripTabIds(orcaPage, splits.rightGroupId)
    const left = await stripGeometry(orcaPage, splits.leftGroupId)
    const hidden = hiddenTabs(await stripGeometry(orcaPage, splits.rightGroupId))

    // Precondition: a point on a visible left tab where a scrolled-off right tab is the closer match.
    let best: { point: Point; target: { id: string; box: Box }; margin: number } | null = null
    for (const target of left.tabs.slice(1)) {
      const y = (target.box.top + target.box.bottom) / 2
      for (let x = Math.ceil(target.box.left) + 2; x < target.box.right - 2; x++) {
        const point = { x, y }
        const covering = hidden.filter(({ box }) => containsX(box, x))
        if (covering.length === 0 || !containsX(left.scroller, x)) {
          continue
        }
        const margin =
          cornerDistance(target.box, point) -
          Math.min(...covering.map(({ box }) => cornerDistance(box, point)))
        if (!best || margin > best.margin) {
          best = { point, target, margin }
        }
      }
    }
    expect(best?.margin ?? 0).toBeGreaterThan(2)
    const { point, target } = best!
    const side = point.x < (target.box.left + target.box.right) / 2 ? 'before' : 'after'

    await dragTab(orcaPage, splits.leftGroupId, leftBefore[0]!, async () => point)

    await expect
      .poll(() => stripTabIds(orcaPage, splits.leftGroupId))
      .toEqual(moved(leftBefore, leftBefore[0]!, target.id, side))
    expect(await stripTabIds(orcaPage, splits.rightGroupId)).toEqual(rightBefore)
  })

  test('a drop in the strip gap after the last tab stays in that split', async ({ orcaPage }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const splits = await buildSplits(orcaPage, worktreeId, { left: 2, right: 24 })
    await scrollStripToEnd(orcaPage, splits.rightGroupId)
    const leftBefore = await stripTabIds(orcaPage, splits.leftGroupId)
    const rightBefore = await stripTabIds(orcaPage, splits.rightGroupId)
    const left = await stripGeometry(orcaPage, splits.leftGroupId)
    const right = await stripGeometry(orcaPage, splits.rightGroupId)
    const leftStrip = (await orcaPage.locator(stripSelector(splits.leftGroupId)).boundingBox())!
    const last = left.tabs.at(-1)!
    const y = (last.box.top + last.box.bottom) / 2

    // Precondition: a gap in the left strip that shows no left tab, with a scrolled-off right tab there.
    let gapX: number | null = null
    for (let x = Math.ceil(last.box.right) + 40; x < leftStrip.x + leftStrip.width - 40; x++) {
      if (hiddenTabs(right).some(({ box }) => containsX(box, x))) {
        gapX = x
        break
      }
    }
    expect(gapX).not.toBeNull()
    expect(left.tabs.some(({ box }) => containsX(box, gapX!))).toBe(false)

    await dragTab(orcaPage, splits.leftGroupId, leftBefore[0]!, async () => ({ x: gapX!, y }))

    await expect
      .poll(() => stripTabIds(orcaPage, splits.leftGroupId))
      .toEqual([...leftBefore.slice(1), leftBefore[0]!])
    expect(await stripTabIds(orcaPage, splits.rightGroupId)).toEqual(rightBefore)
  })
})
