import { expect, test, type Page } from '@playwright/test'

// The resume report must not move while hovered. Its body loads lazily; a toast the toaster measured
// before that body rendered dropped onto the status bar on hover and jittered (STA-19348).
// Real pointer, cold page, motion on so the toaster's expand transition is sampled frame by frame,
// and a 600px viewport: the narrowest main window, where the toaster switches to its narrow layout.
test.use({ viewport: { width: 600, height: 420 }, reducedMotion: 'no-preference' })

type Rect = { top: number; bottom: number; height: number }
type Frame = { report: Rect; other: Rect | null; expanded: boolean }

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window needs declaration merging.
  interface Window {
    /** Frames recorded by startSampling in the fixture page. */
    __hoverFrames?: Frame[]
    __hoverSampling?: boolean
  }
}

const REPORT = '[data-sonner-toast] section'
const TOLERANCE = 0.5

// A cold fixture page compiles on first load; give it longer than the default expect timeout.
const LOAD_TIMEOUT = 30_000
// Sonner's transform/height transition is 400ms; sample a little past it.
const TRANSITION_MS = 600

async function openScene(page: Page, scene: 'corner' | 'stacked', theme: string): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat-recovery/toast/ResumeToastHover:${scene}&theme=${theme}`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: LOAD_TIMEOUT
  })
  await expect(page.locator(REPORT)).toBeVisible({ timeout: LOAD_TIMEOUT })
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(scene === 'stacked' ? 2 : 1)
  // Past the toaster's enter transition: the report holds still across a transition's length.
  await expect
    .poll(
      async () => {
        const first = await page.locator(REPORT).boundingBox()
        await page.waitForTimeout(TRANSITION_MS)
        const second = await page.locator(REPORT).boundingBox()
        return first !== null && second !== null && first.y === second.y
      },
      { timeout: LOAD_TIMEOUT }
    )
    .toBe(true)
}

/** Records, every animation frame until stopped, the report's box, the other toast's box, and whether the stack is expanded. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const box = (element: Element): Rect => {
      const { top, bottom, height } = element.getBoundingClientRect()
      return { top, bottom, height }
    }
    const frames: Frame[] = []
    window.__hoverFrames = frames
    window.__hoverSampling = true
    const tick = (): void => {
      const report = document.querySelector(selector)
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')]
      const other = toasts.find((toast) => !toast.contains(report))
      if (report) {
        frames.push({
          report: box(report),
          other: other ? box(other) : null,
          expanded: toasts.every((toast) => toast.getAttribute('data-expanded') === 'true')
        })
      }
      if (window.__hoverSampling) {
        requestAnimationFrame(tick)
      }
    }
    tick()
  }, REPORT)
}

function stopSampling(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    window.__hoverSampling = false
    return window.__hoverFrames ?? []
  })
}

function expectStackExpanded(page: Page, expanded: boolean): Promise<void> {
  return expect(page.locator(`[data-sonner-toast][data-expanded="${!expanded}"]`)).toHaveCount(0, {
    timeout: LOAD_TIMEOUT
  })
}

function expectReportStill(frames: Frame[], rest: Rect): void {
  // Sampled from before the pointer moved until past the transition, so it spans every moving frame.
  expect(frames.length).toBeGreaterThan(2)
  for (const [index, { report }] of frames.entries()) {
    expect(
      Math.abs(report.top - rest.top),
      `report top moved at frame ${index}`
    ).toBeLessThanOrEqual(TOLERANCE)
    expect(
      Math.abs(report.height - rest.height),
      `report height changed at frame ${index}`
    ).toBeLessThanOrEqual(TOLERANCE)
  }
}

async function hoverAndLeave(page: Page): Promise<{ rest: Frame; hover: Frame[]; leave: Frame[] }> {
  await page.mouse.move(5, 5)
  await startSampling(page)
  const [rest] = await stopSampling(page)
  const card = await page.locator(REPORT).boundingBox()
  if (!rest || !card) {
    throw new Error('The resume report is not on screen')
  }
  await startSampling(page)
  // Enter over the headline and wander across the card, the way a person reads it.
  await page.mouse.move(card.x + card.width * 0.3, card.y + card.height / 2, { steps: 4 })
  await page.mouse.move(card.x + card.width * 0.7, card.y + card.height / 2 + 3, { steps: 8 })
  await expectStackExpanded(page, true)
  await page.waitForTimeout(TRANSITION_MS)
  const hover = await stopSampling(page)
  await startSampling(page)
  await page.mouse.move(5, 5, { steps: 4 })
  await expectStackExpanded(page, false)
  await page.waitForTimeout(TRANSITION_MS)
  const leave = await stopSampling(page)
  return { rest, hover, leave }
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(theme, () => {
    test('the toaster is in its narrow layout at the narrowest window', async ({ page }) => {
      await openScene(page, 'corner', theme)
      // Wide, the toaster is capped at its 26rem --width (416px here); narrow, it spans its container.
      const { toaster, container } = await page
        .locator('[data-sonner-toaster]')
        .evaluate((element) => ({
          toaster: element.getBoundingClientRect().width,
          container: element.parentElement?.getBoundingClientRect().width ?? 0
        }))
      expect(toaster).toBeGreaterThan(416 + TOLERANCE)
      expect(Math.abs(toaster - container)).toBeLessThanOrEqual(TOLERANCE)
    })

    test('hovering the report alone leaves it in place through expand and leave', async ({
      page
    }) => {
      await openScene(page, 'corner', theme)
      const { rest, hover, leave } = await hoverAndLeave(page)
      expectReportStill(hover, rest.report)
      expectReportStill(leave, rest.report)
      expect(hover.at(-1)?.expanded).toBe(true)
      expect(leave.at(-1)?.expanded).toBe(false)
    })

    test('hovering the report fans the toast behind it out above, and the report stays put', async ({
      page
    }) => {
      await openScene(page, 'stacked', theme)
      const { rest, hover, leave } = await hoverAndLeave(page)
      expectReportStill(hover, rest.report)
      expectReportStill(leave, rest.report)

      const settled = hover.at(-1)
      expect(settled?.expanded).toBe(true)
      expect(rest.other).not.toBeNull()
      // The other toast rises without ever coming back down, and ends clear of the report.
      let previousTop = rest.other!.top
      for (const [index, { other }] of hover.entries()) {
        expect(other, `other toast missing at frame ${index}`).not.toBeNull()
        expect(other!.top, `other toast fell back at frame ${index}`).toBeLessThanOrEqual(
          previousTop + TOLERANCE
        )
        previousTop = other!.top
      }
      expect(settled!.other!.bottom).toBeLessThanOrEqual(settled!.report.top + TOLERANCE)
      expect(settled!.other!.top).toBeLessThan(rest.other!.top - 10)

      expect(leave.at(-1)?.expanded).toBe(false)
    })
  })
}
