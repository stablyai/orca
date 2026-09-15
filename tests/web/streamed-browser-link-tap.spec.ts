import { expect, test, type CDPSession } from '@playwright/test'
import {
  computeBrowserFrameGeometry,
  computeBrowserTouchClickRadiusCss,
  mapScreenToBrowserPoint
} from '../../mobile/src/browser/browser-touch-geometry'
import { mobileTouchClickExpression } from '../../src/main/browser/agent-browser-bridge-mouse'
import { resolveRemoteBrowserCssViewport } from '../../src/renderer/src/components/browser-pane/stream-remote/remote-browser-page-input-model'
import type { BrowserScreencastFrameMetadata } from '../../src/shared/browser-screencast-protocol'

const layout = { width: 390, height: 664 }
const zoom = { scale: 1, offsetX: 0, offsetY: 0 }
const source = (responsive: boolean) => `<!doctype html>
${responsive ? '<meta name="viewport" content="width=device-width,initial-scale=1">' : ''}
<style>body{margin:0;height:3000px}main{position:absolute;left:60px;top:500px;width:220px}a,button{display:block;min-height:48px;margin-bottom:8px}iframe{width:220px;height:80px;border:0}</style>
<main><a id="markdown" href="#markdown-opened">Markdown body link</a>
<a id="automatic" href="#automatic-opened">https://example.com</a>
<a id="internal" href="#internal-opened">Internal anchor</a>
<a id="card" href="#card-opened"><strong>Card link</strong></a>
<button id="button" onclick="location.hash='button-opened'">Button link</button>
<a id="external" href="/tests/web/fixtures/mobile-link-tap/destination.html" target="_blank">External link</a>
<iframe srcdoc="<a id='inner' href='#opened' style='display:block;min-height:48px'>Iframe link</a>"></iframe></main>`

/**
 * Captures one real screencast frame with its metadata, then stops the screencast.
 *
 * The metadata carries the page scale under test, so coordinate mapping is exercised
 * against values Chromium actually reported rather than hand-written fixtures.
 */
async function frame(cdp: CDPSession) {
  const next = new Promise<{
    data: string
    metadata: BrowserScreencastFrameMetadata
    sessionId: number
  }>((resolve) => cdp.once('Page.screencastFrame', resolve))
  await cdp.send('Page.startScreencast', {
    format: 'png',
    maxWidth: 390,
    maxHeight: 664,
    everyNthFrame: 1
  })
  const result = await next
  await cdp.send('Page.screencastFrameAck', { sessionId: result.sessionId })
  await cdp.send('Page.stopScreencast')
  return result
}

/**
 * Dispatches a trusted press/release pair at a page point through CDP.
 */
async function click(cdp: CDPSession, point: { x: number; y: number }) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1
  })
}

test('scaled stream before/after: identical visual tap hits BODY then the link', async ({
  page,
  context
}, testInfo) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...layout,
    deviceScaleFactor: 2,
    mobile: true
  })
  await page.setContent(
    '<!doctype html><style>body{margin:0;height:4000px}a{position:absolute;left:300px;top:350px;width:150px;height:48px;background:yellow}output{position:fixed;top:0;font-size:32px;pointer-events:none}</style><output>Awaiting tap</output><a id="markdown" href="#opened">Markdown link</a>'
  )
  await page.evaluate(() => {
    Object.assign(window, { events: [] })
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      document.addEventListener(type, (event) => {
        if (type === 'click') {
          document.querySelector('output')!.textContent =
            `Last click: ${(event.target as Element).id || (event.target as Element).tagName}`
        }
        const mouse = event as MouseEvent
        ;(window as unknown as { events: object[] }).events.push({
          type,
          target: (event.target as Element).id || (event.target as Element).tagName,
          x: mouse.clientX,
          y: mouse.clientY,
          defaultPrevented: event.defaultPrevented,
          isTrusted: event.isTrusted
        })
      })
    }
  })
  const before = await frame(cdp)
  const scale = before.metadata.pageScaleFactor!
  expect(scale).toBeCloseTo(390 / 980, 5)
  const screenPoint = { x: 375 * scale, y: 374 * scale }
  const oldPoint = mapScreenToBrowserPoint(
    screenPoint.x,
    screenPoint.y,
    layout,
    { ...before.metadata, pageScaleFactor: 1 },
    zoom
  )!
  await click(cdp, oldPoint)
  await expect(page).not.toHaveURL(/#opened$/)
  const oldEvents = await page.evaluate(() =>
    (window as unknown as { events: object[] }).events.splice(0)
  )
  expect(oldEvents).toContainEqual(
    expect.objectContaining({
      type: 'click',
      target: 'BODY',
      defaultPrevented: false,
      isTrusted: true
    })
  )
  const missedFrame = await frame(cdp)
  const correctedPoint = mapScreenToBrowserPoint(
    screenPoint.x,
    screenPoint.y,
    layout,
    before.metadata,
    zoom
  )!
  await click(cdp, correctedPoint)
  await expect(page).toHaveURL(/#opened$/)
  const events = await page.evaluate(() => (window as unknown as { events: object[] }).events)
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'click',
      target: 'markdown',
      defaultPrevented: false,
      isTrusted: true
    })
  )
  await testInfo.attach('scale-event-evidence', {
    body: JSON.stringify(
      { metadata: before.metadata, screenPoint, oldPoint, oldEvents, correctedPoint, events },
      null,
      2
    ),
    contentType: 'application/json'
  })
  await testInfo.attach('scaled-source-before', {
    body: Buffer.from(missedFrame.data, 'base64'),
    contentType: 'image/png'
  })
  await testInfo.attach('scaled-source-after', {
    body: Buffer.from((await frame(cdp)).data, 'base64'),
    contentType: 'image/png'
  })
})

for (const mode of ['mobile', 'responsive', 'zoomed', 'desktop'] as const) {
  test(`${mode}: streamed Markdown, automatic, internal, card, button and iframe links activate after scroll`, async ({
    page,
    context
  }, testInfo) => {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...layout,
      deviceScaleFactor: 2,
      mobile: mode !== 'desktop'
    })
    await page.route('**/stream-source', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: source(mode === 'responsive' || mode === 'zoomed')
      })
    )
    await page.goto('/stream-source')
    if (mode === 'zoomed') {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 })
    }
    const evidence: object[] = []
    for (const id of ['markdown', 'automatic', 'internal', 'card', 'button', 'external']) {
      const element = page.locator(`#${id}`)
      await element.evaluate((element) => element.scrollIntoView({ block: 'center' }))
      const rect = await element.boundingBox()
      const captured = await frame(cdp)
      const metadata = captured.metadata
      const scale = metadata.pageScaleFactor!
      expect(scale).toBeCloseTo(mode === 'mobile' ? 390 / 980 : mode === 'zoomed' ? 1.25 : 1, 5)
      const geometry = computeBrowserFrameGeometry(layout, metadata)!
      const cssPoint = { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 }
      const point = mapScreenToBrowserPoint(
        geometry.offsetX + cssPoint.x * scale * geometry.scale,
        geometry.offsetY + cssPoint.y * scale * geometry.scale,
        layout,
        metadata,
        zoom
      )!
      expect(point.x).toBeCloseTo(cssPoint.x, 0)
      expect(point.y).toBeCloseTo(cssPoint.y, 0)
      const remoteViewport = resolveRemoteBrowserCssViewport({
        cssViewportSize: layout,
        requestedViewportSize: layout,
        frameMetadata: metadata,
        naturalSize: layout
      })
      expect(remoteViewport.width).toBeCloseTo(layout.width / scale, 4)
      const popupPromise = id === 'external' ? page.waitForEvent('popup') : null
      // Exercise the existing runtime hit test and native CDP dispatch, preserving modifiers.
      const resolved = await cdp.send('Runtime.evaluate', {
        expression: mobileTouchClickExpression(
          point.x,
          point.y,
          computeBrowserTouchClickRadiusCss(layout, metadata, zoom, 14),
          false
        ),
        returnByValue: true
      })
      const hit = resolved.result.value as { x: number; y: number }
      await click(cdp, { x: hit.x, y: hit.y })
      if (popupPromise) {
        const popup = await popupPromise
        await expect(popup.getByRole('heading')).toHaveText('Link destination')
        await popup.close()
      } else {
        await expect(page).toHaveURL(new RegExp(`#${id}-opened$`))
      }
      evidence.push({ id, metadata, cssPoint, point, hit })
    }
    const iframe = page.locator('iframe')
    await iframe.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    const inner = page.frameLocator('iframe').getByRole('link')
    const rect = await inner.boundingBox()
    const metadata = (await frame(cdp)).metadata
    const scale = metadata.pageScaleFactor!
    const point = mapScreenToBrowserPoint(
      (rect!.x + rect!.width / 2) * scale,
      (rect!.y + rect!.height / 2) * scale,
      layout,
      metadata,
      zoom
    )!
    await click(cdp, point)
    await expect.poll(() => page.frames()[1].url()).toMatch(/#opened$/)
    const beforeScroll = await page.evaluate(() => window.scrollY)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 10,
      y: 10,
      deltaX: 0,
      deltaY: 40
    })
    await expect
      .poll(async () =>
        Math.round(((await page.evaluate(() => window.scrollY)) - beforeScroll) * scale)
      )
      .toBe(40)
    await testInfo.attach('streamed-link-matrix', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json'
    })
  })
}
