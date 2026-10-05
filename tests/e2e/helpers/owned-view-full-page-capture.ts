import type { Page, TestInfo } from '@stablyai/playwright-test'
import { z } from 'zod'
import type { DesktopBrowserViewIdentity } from '../../../src/shared/desktop-browser-view-protocol'
import { expect } from './orca-app'

const metricsSchema = z.object({
  documentWidth: z.number().int().positive(),
  documentHeight: z.number().int().positive(),
  innerWidth: z.number().int().positive(),
  innerHeight: z.number().int().positive(),
  devicePixelRatio: z.number().finite().positive(),
  scrollX: z.number().finite(),
  scrollY: z.number().finite(),
  timeOrigin: z.number().finite().positive(),
  url: z.string(),
  readyState: z.string()
})
const metricsExpression = `({
  documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY,
  timeOrigin: performance.timeOrigin, url: location.href, readyState: document.readyState
})`

type NativeLayout = {
  guestId: number
  ownerVisible: boolean
  visible: boolean
  containerVisible: boolean
  guestVisible: boolean
  scale: number
  owner: { x: number; y: number; width: number; height: number }
  container: { x: number; y: number; width: number; height: number }
  content: { x: number; y: number; width: number; height: number }
}

async function callBrowser(page: Page, method: string, params: Record<string, unknown>) {
  const response = await page.evaluate((request) => window.api.runtime.call(request), {
    method,
    params
  })
  if (!response.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(response.error)}`)
  }
  return response.result
}

async function readMetrics(page: Page, target: { page: string; worktree: string }) {
  const result = z
    .object({ result: z.string(), origin: z.string() })
    .parse(await callBrowser(page, 'browser.eval', { ...target, expression: metricsExpression }))
  const metrics = metricsSchema.parse(JSON.parse(result.result))
  expect(result.origin).toBe(metrics.url)
  return metrics
}

async function readIdentity(page: Page, identity: DesktopBrowserViewIdentity) {
  return page.evaluate(async (target) => {
    const api = window.api.browser.desktopView
    if (!api) {
      throw new Error('Ordinary desktop preload API missing')
    }
    const { state } = await api.command({ ...target, command: { kind: 'snapshot' } })
    return {
      browserPageId: state.browserPageId,
      generation: state.generation,
      url: state.url,
      zoomLevel: state.zoomLevel
    }
  }, identity)
}

export async function assertOwnedViewFullPageCapture({
  page,
  identity,
  worktreeId,
  url,
  expectedGuestId,
  readNative,
  testInfo
}: {
  page: Page
  identity: DesktopBrowserViewIdentity
  worktreeId: string
  url: string
  expectedGuestId: number
  readNative: () => Promise<NativeLayout | null>
  testInfo: TestInfo
}): Promise<void> {
  const target = { page: identity.browserPageId, worktree: `id:${worktreeId}` }
  const request = { method: 'browser.fullScreenshot', params: { ...target, format: 'png' } }
  const receipt: Record<string, unknown> = { request, identity, expectedGuestId }
  try {
    const beforeIdentity = await readIdentity(page, identity)
    const beforeMetrics = await readMetrics(page, target)
    const beforeNative = await readNative()
    receipt.before = { identity: beforeIdentity, metrics: beforeMetrics, native: beforeNative }
    expect(beforeIdentity).toMatchObject({ ...identity, url, zoomLevel: 0 })
    expect(beforeNative?.guestId).toBe(expectedGuestId)
    expect(beforeNative?.ownerVisible).toBe(false)
    expect(beforeNative?.visible).toBe(true)
    expect(beforeMetrics.url).toBe(url)
    expect(beforeMetrics.readyState).toBe('complete')
    expect(beforeMetrics.documentHeight).toBe(4096)
    expect(beforeMetrics.documentHeight).toBeGreaterThan(beforeMetrics.innerHeight)

    const capture = z
      .object({ data: z.string().min(1), format: z.literal('png') })
      .parse(await callBrowser(page, request.method, request.params))
    const png = Buffer.from(capture.data, 'base64')
    receipt.result = { format: capture.format, bytes: png.length }
    await testInfo.attach('owned-view-full-page.png', { body: png, contentType: 'image/png' })

    const afterMetrics = await readMetrics(page, target)
    const afterIdentity = await readIdentity(page, identity)
    const afterNative = await readNative()
    receipt.after = { identity: afterIdentity, metrics: afterMetrics, native: afterNative }
    const decoded = await page.evaluate(
      async ({ data, metrics }) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('Full-page PNG decoder canvas unavailable')
        }
        context.drawImage(image, 0, 0)
        const samples = [0, 1, 2, 3].flatMap((band) =>
          [256, 512, 768].map((offset) => {
            const cssY = band * 1024 + offset
            const x = Math.floor((metrics.documentWidth / 2) * metrics.devicePixelRatio)
            const y = Math.floor(cssY * metrics.devicePixelRatio)
            return { band, cssY, x, y, rgba: Array.from(context.getImageData(x, y, 1, 1).data) }
          })
        )
        return { width: image.naturalWidth, height: image.naturalHeight, samples }
      },
      { data: capture.data, metrics: beforeMetrics }
    )
    const expected = {
      width: Math.round(beforeMetrics.documentWidth * beforeMetrics.devicePixelRatio),
      height: Math.round(beforeMetrics.documentHeight * beforeMetrics.devicePixelRatio),
      bandColors: [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255]
      ]
    }
    receipt.pixels = { decoded, expected }
    expect(Math.abs(decoded.width - expected.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(decoded.height - expected.height)).toBeLessThanOrEqual(1)
    expect(decoded.height).toBeGreaterThan(
      beforeMetrics.innerHeight * beforeMetrics.devicePixelRatio
    )
    for (const sample of decoded.samples) {
      expect(sample.rgba).toEqual(expected.bandColors[sample.band])
    }
    expect(afterMetrics).toEqual(beforeMetrics)
    expect(afterIdentity).toEqual(beforeIdentity)
    expect(afterNative?.guestId).toBe(expectedGuestId)
    expect(afterNative?.ownerVisible).toBe(false)
    expect(afterNative?.visible).toBe(beforeNative?.visible)
    expect(afterNative?.containerVisible).toBe(beforeNative?.containerVisible)
    expect(afterNative?.guestVisible).toBe(beforeNative?.guestVisible)
    expect(afterNative?.scale).toBe(beforeNative?.scale)
    expect(afterNative?.owner).toEqual(beforeNative?.owner)
    expect(afterNative?.container).toEqual(beforeNative?.container)
    expect(afterNative?.content).toEqual(beforeNative?.content)
  } catch (error) {
    receipt.error = String(error)
    throw error
  } finally {
    await testInfo
      .attach('owned-view-full-page.json', {
        body: JSON.stringify(receipt, null, 2),
        contentType: 'application/json'
      })
      .catch((error: unknown) =>
        console.warn('[owned-view-e2e] full-page receipt failed:', String(error))
      )
  }
}
