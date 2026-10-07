/**
 * E2E test for scrolling an overflowing tab strip: the scroll must not re-render the tabs, and the
 * scroll thumb must still track the strip.
 *
 * Why E2E: only real Chromium lays out the strip and delivers the scroll and resize callbacks the
 * thumb follows, and only the whole app shows every React commit a scroll step causes.
 */

import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'

const STRIP = '.terminal-tab-strip'
const START_SCROLL_LEFT_PX = 400
const WHEEL_STEPS = 20
const WHEEL_DELTA_PX = 50
const MIN_SCROLL_RANGE_PX = 2_000

type CommitFiber = {
  tag: number
  flags: number
  child: CommitFiber | null
  sibling: CommitFiber | null
  stateNode: unknown
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
      onCommitFiberRoot?: (
        rendererId: unknown,
        root: { current: CommitFiber },
        ...rest: unknown[]
      ) => unknown
    }
    __tabsRenderedPerCommit?: number[]
  }
}

async function addBackgroundTerminalTabs(
  page: Page,
  worktreeId: string,
  count: number
): Promise<string[]> {
  return page.evaluate(
    ({ wId, tabCount }) =>
      Array.from(
        { length: tabCount },
        () =>
          window.__store!.getState().createTab(wId, undefined, undefined, { activate: false }).id
      ),
    { wId: worktreeId, tabCount: count }
  )
}

/**
 * Records how many tabs each React commit re-renders, the way React DevTools highlights updates:
 * through the commit hook the renderer always installs. Commits that render no tab (the sidebar,
 * terminals starting up) are left out.
 */
async function startRecordingTabRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Function, class, forwardRef and memo components; bit 1 is React's PerformedWork flag.
    const componentTags = new Set([0, 1, 11, 14, 15])
    const performedWork = 1
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__!
    const original = hook.onCommitFiberRoot
    // A subtree React skipped keeps last commit's fiber objects, whose flags are stale.
    let previousFibers = new Set<CommitFiber>()
    window.__tabsRenderedPerCommit = []
    hook.onCommitFiberRoot = function (rendererId, root, ...rest) {
      const fibers = new Set<CommitFiber>()
      const renderedTabIds = new Set<string>()
      const stack: CommitFiber[] = [root.current]
      while (stack.length > 0) {
        const fiber = stack.pop()!
        fibers.add(fiber)
        if (
          componentTags.has(fiber.tag) &&
          (fiber.flags & performedWork) === performedWork &&
          !previousFibers.has(fiber)
        ) {
          let host: CommitFiber | null = fiber
          while (host && host.tag !== 5) {
            host = host.child
          }
          const element = host?.stateNode
          const tabId =
            element instanceof Element
              ? element.closest('[data-tab-strip-slot]')?.getAttribute('data-tab-strip-slot')
              : undefined
          if (tabId) {
            renderedTabIds.add(tabId)
          }
        }
        if (fiber.sibling) {
          stack.push(fiber.sibling)
        }
        if (fiber.child) {
          stack.push(fiber.child)
        }
      }
      previousFibers = fibers
      if (renderedTabIds.size > 0) {
        window.__tabsRenderedPerCommit?.push(renderedTabIds.size)
      }
      return original?.call(this, rendererId, root, ...rest)
    }
  })
}

async function takeTabRenders(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const recorded = window.__tabsRenderedPerCommit ?? []
    window.__tabsRenderedPerCommit = []
    return recorded
  })
}

/** Thumb geometry next to where the strip's scroll position and size say it should be. */
async function readThumb(strip: Locator) {
  return strip.evaluate((el) => {
    const track = el.parentElement!.querySelector<HTMLElement>(
      '[data-testid="tab-strip-scroll-indicator"]'
    )!
    const trackRect = track.getBoundingClientRect()
    const thumbRect = track
      .querySelector<HTMLElement>('[data-testid="tab-strip-scroll-thumb"]')!
      .getBoundingClientRect()
    const maxScrollLeft = el.scrollWidth - el.clientWidth
    const expectedWidth = Math.max(18, (el.clientWidth / el.scrollWidth) * trackRect.width)
    return {
      width: thumbRect.width,
      expectedWidth,
      left: thumbRect.left - trackRect.left,
      expectedLeft: (el.scrollLeft / maxScrollLeft) * (trackRect.width - expectedWidth)
    }
  })
}

/** Polls rather than waiting frames: CI's hidden window can draw as little as one frame a second. */
async function expectThumbToTrackStrip(strip: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const thumb = await readThumb(strip)
      return Math.max(
        Math.abs(thumb.width - thumb.expectedWidth),
        Math.abs(thumb.left - thumb.expectedLeft)
      )
    })
    .toBeLessThanOrEqual(1)
}

test.describe('Tab strip scroll render isolation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('scrolls a long strip without re-rendering its tabs, and the thumb keeps up', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const strip = orcaPage.locator(STRIP).first()
    await expect(strip).toBeVisible()
    const tabIds: string[] = []
    for (let i = 0; i < 12; i++) {
      const range = await strip.evaluate((el) => el.scrollWidth - el.clientWidth)
      if (range >= MIN_SCROLL_RANGE_PX) {
        break
      }
      tabIds.push(...(await addBackgroundTerminalTabs(orcaPage, worktreeId, 10)))
      await expect
        .poll(() => strip.evaluate((el) => el.querySelectorAll('[data-tab-strip-slot]').length))
        .toBeGreaterThan(tabIds.length)
    }

    await startRecordingTabRenders(orcaPage)
    // New terminals retitle their tabs after opening, longer on a loaded machine; wait for quiet.
    await expect
      .poll(
        async () => {
          await takeTabRenders(orcaPage)
          await orcaPage.waitForTimeout(1_500)
          return (await takeTabRenders(orcaPage)).length
        },
        { timeout: 45_000 }
      )
      .toBe(0)
    expect(await strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThanOrEqual(
      MIN_SCROLL_RANGE_PX
    )

    // Start and end mid-strip so neither scroll edge flips the arrows, fades or dock. Why set it
    // here and hold until it sticks: opening the tabs left the strip pinned to its end, and the
    // scroll event that releases that pin only lands with the next frame — about a second in CI's
    // hidden window. A tab retitling inside that window re-pins the strip to the end.
    await expect
      .poll(
        async () => {
          await strip.evaluate((el, left) => {
            el.scrollLeft = left
          }, START_SCROLL_LEFT_PX)
          await orcaPage.waitForTimeout(1_500)
          return strip.evaluate((el) => el.scrollLeft)
        },
        { timeout: 30_000 }
      )
      .toBe(START_SCROLL_LEFT_PX)
    // That scroll flipped the end-edge flags; the commit it caused is not the scroll under test.
    await takeTabRenders(orcaPage)
    // Why wheel events dispatched in the page: real input waits for a frame per step, and CI's hidden
    // window draws about one a second. The strip's own wheel handler still does the scrolling.
    await strip.evaluate(
      async (el, { steps, delta }) => {
        for (let i = 0; i < steps; i++) {
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, cancelable: true }))
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        // The scroll events arrive with the next frame; let React commit what they cause.
        await new Promise(requestAnimationFrame)
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
      { steps: WHEEL_STEPS, delta: WHEEL_DELTA_PX }
    )
    expect(await strip.evaluate((el) => el.scrollLeft)).toBe(
      START_SCROLL_LEFT_PX + WHEEL_STEPS * WHEEL_DELTA_PX
    )
    // Why "many tabs": before the fix every scroll step re-rendered all of them in one commit;
    // a single tab can still update itself (a late retitle).
    expect((await takeTabRenders(orcaPage)).filter((tabs) => tabs >= 3)).toEqual([])
    await expectThumbToTrackStrip(strip)

    // Control: switching tabs re-renders at least the tab it activates, so the recorder sees tabs.
    await orcaPage.evaluate((tabId) => window.__store!.getState().setActiveTab(tabId), tabIds[0])
    await expect.poll(async () => (await takeTabRenders(orcaPage)).length).toBeGreaterThan(0)

    // Tabs opening grow the strip without a scroll event.
    await addBackgroundTerminalTabs(orcaPage, worktreeId, 10)
    await expectThumbToTrackStrip(strip)

    // A narrower pane shrinks the strip and the track without a scroll event.
    await strip.evaluate((el) => {
      el.closest<HTMLElement>('[data-native-file-drop-target]')!.style.maxWidth = '700px'
    })
    await expectThumbToTrackStrip(strip)
  })
})
