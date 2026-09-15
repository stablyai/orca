import { expect, test, type Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'

/**
 * Viewport point at the middle of a terminal row, for tapping a known rendered cell.
 */
async function cellPoint(page: Page, row: number) {
  const rect = await page.locator('.xterm-screen').boundingBox()
  if (!rect) {
    throw new Error('Terminal screen missing')
  }
  return { x: rect.x + 40, y: rect.y + ((row + 0.5) * rect.height) / 6 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/web/fixtures/mobile-link-tap/index.html')
  await expect(page.getByTestId('terminal')).toHaveAttribute('data-ready', 'true')
})

test('without touch handling xterm cancels the tap before mouse link activation', async ({
  page,
  isMobile
}, testInfo) => {
  test.skip(!isMobile, 'Documents the native touch failure with the new installer disabled')
  await page.goto('/tests/web/fixtures/mobile-link-tap/index.html?withoutTouchLinks')
  await expect(page.getByTestId('terminal')).toHaveAttribute('data-ready', 'true')
  await page.evaluate(() => {
    const events: object[] = []
    Object.assign(window, { tapEvents: events })
    for (const type of [
      'pointerdown',
      'pointerup',
      'touchstart',
      'touchend',
      'mousedown',
      'mouseup',
      'click'
    ]) {
      for (const capture of [true, false]) {
        document.addEventListener(
          type,
          (event) => {
            events.push({
              type,
              capture,
              target: (event.target as Element).className,
              defaultPrevented: event.defaultPrevented,
              isTrusted: event.isTrusted
            })
          },
          capture
        )
      }
    }
  })
  const point = await cellPoint(page, 0)
  await page.touchscreen.tap(point.x, point.y)
  await expect(page.locator('[data-link-action-popover]')).toHaveCount(0)
  const events = await page.evaluate(
    () =>
      (
        window as unknown as {
          tapEvents: { type: string; capture: boolean; defaultPrevented: boolean }[]
        }
      ).tapEvents
  )
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'touchstart', capture: false, defaultPrevented: true })
  )
  expect(events.some((event) => event.type === 'click')).toBe(false)
  await testInfo.attach('baseline-touch-events', {
    body: JSON.stringify(events, null, 2),
    contentType: 'application/json'
  })
  await page.screenshot({ path: testInfo.outputPath('baseline.png') })
})

test('first tap activates URL, Markdown file and OSC label without hover', async ({
  page,
  isMobile
}, testInfo) => {
  for (const [row, destination] of [
    [0, 'https://example.com/tap'],
    [1, '/repo/README.md'],
    [2, 'https://example.com/osc']
  ] as const) {
    const point = await cellPoint(page, row)
    await (isMobile ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y))
    const popover = page.locator('[data-link-action-popover]')
    await expect(popover).toBeVisible()
    await expect(popover.locator('[data-terminal-link-destination]')).toHaveText(destination)
    for (const button of await popover.getByRole('button').all()) {
      await expect.poll(async () => (await button.boundingBox())!.width).toBeGreaterThanOrEqual(24)
      await expect.poll(async () => (await button.boundingBox())!.height).toBeGreaterThanOrEqual(24)
    }
    await page.screenshot({ path: testInfo.outputPath(`link-row-${row}.png`) })
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  }
})

test('Markdown body, automatic, anchor, card and button links remain native click targets', async ({
  page,
  isMobile
}) => {
  for (const name of ['Markdown body', /destination\.html$/, 'Card link', 'External button']) {
    const target =
      name === 'External button'
        ? page.getByRole('button', { name })
        : page.getByRole('link', { name, exact: true })
    const popupPromise = page.waitForEvent('popup')
    await (isMobile ? target.tap() : target.click())
    const popup = await popupPromise
    await expect(popup.getByRole('heading')).toHaveText('Link destination')
    await popup.close()
  }
  const anchor = page.getByRole('link', { name: 'Internal anchor' })
  await (isMobile ? anchor.tap() : anchor.click())
  await expect(page.getByRole('heading', { name: 'Target', exact: true })).toBeInViewport()
})

test('terminal link action opens the browser destination', async ({ page, context, isMobile }) => {
  await context.route('https://example.com/tap', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Terminal destination</h1>' })
  )
  const point = await cellPoint(page, 0)
  await (isMobile ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y))
  const action = page
    .locator('[data-link-action-popover]')
    .getByRole('button', { name: /System Browser|Open link/ })
  const popupPromise = page.waitForEvent('popup')
  await (isMobile ? action.tap() : action.click())
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://example.com/tap')
  await expect(popup.getByRole('heading')).toHaveText('Terminal destination')
  await popup.close()
  await expect(page.locator('[data-link-action-popover]')).toBeHidden()
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
})

test('touch scroll, long press, selection and cancellation never activate a link', async ({
  page,
  browserName,
  isMobile
}) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'CDP touch sequences require mobile Chromium')
  const cdp = await page.context().newCDPSession(page)
  const point = await cellPoint(page, 0)
  const touch = (x: number, y: number) => ({ x, y, id: 1 })
  for (const gesture of ['scroll', 'return-drag', 'long-press', 'cancel', 'selection', 'pinch']) {
    if (gesture === 'selection') {
      await page.evaluate(() => {
        ;(window as unknown as { terminal: Terminal }).terminal.select(0, 0, 5)
      })
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touch(point.x, point.y)]
    })
    if (gesture === 'long-press') {
      await new Promise((resolve) => setTimeout(resolve, 550))
    }
    if (gesture === 'scroll' || gesture === 'return-drag') {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touch(point.x, point.y + 50)]
      })
      if (gesture === 'return-drag') {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [touch(point.x, point.y)]
        })
      }
    }
    if (gesture === 'pinch') {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [touch(point.x, point.y), { x: point.x + 80, y: point.y + 40, id: 2 }]
      })
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: gesture === 'cancel' ? 'touchCancel' : 'touchEnd',
      touchPoints: []
    })
    await expect(page.locator('[data-link-action-popover]')).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as unknown as { terminal: Terminal }).terminal.clearSelection()
    })
  }
  await cdp.detach()
})

test('touch scrolling still moves terminal scrollback', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'CDP touch scroll requires mobile Chromium')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        ;(window as unknown as { terminal: Terminal }).terminal.write(
          Array.from({ length: 100 }, (_, index) => `scroll line ${index}\r\n`).join(''),
          resolve
        )
      })
  )
  await expect(page.locator('.xterm-rows')).toContainText('scroll line 99')
  const point = await cellPoint(page, 0)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...point, id: 1 }]
  })
  for (const dy of [20, 40, 60, 80]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y: point.y + dy, id: 1 }]
    })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(page.locator('.xterm-rows')).not.toContainText('scroll line 99')
  await expect(page.locator('.xterm-rows')).toContainText('scroll line')
  await expect(page.locator('[data-link-action-popover]')).toHaveCount(0)
  await cdp.detach()
})
