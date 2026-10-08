import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import type { Page } from '@stablyai/playwright-test'
import {
  recordFallbackDiagnostic,
  type FallbackDiagnostics,
  type ScreenRect
} from './owned-view-composed-rendezvous'
import { createServer } from 'node:http'

export async function startGuest() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Composed synthetic guest</title>
      <style>body{margin:0;background:rgb(244,244,244)}div{position:absolute;top:32px;width:120px;height:70px}</style>
      <div id="native-proof-patch" style="left:32px;background:rgb(255,0,0)"></div>
      <div style="left:180px;background:rgb(0,255,0)"></div>
      <div style="left:328px;background:rgb(0,0,255)"></div>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Guest address missing')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

export async function readFallback(
  page: Page,
  pageId: string,
  content: ScreenRect,
  guestZoom: number,
  diagnostics: FallbackDiagnostics
) {
  const source = await page
    .locator(`[data-browser-page-viewport-id="${pageId}"] [data-browser-page-content] img`)
    .evaluateAll((images) => {
      if (
        images.length !== 1 ||
        !(images[0] instanceof HTMLImageElement) ||
        !images[0].complete ||
        images[0].naturalWidth <= 0
      ) {
        return null
      }
      return images[0].currentSrc || images[0].src
    })
  if (source === null) {
    recordFallbackDiagnostic(diagnostics, { status: 'image-not-ready', content, guestZoom })
    return null
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(source)) {
    throw new Error('Unexpected renderer fallback image')
  }
  const bytes = Buffer.from(source.slice('data:image/png;base64,'.length), 'base64')
  const png = PNG.sync.read(bytes)
  const point = {
    x: Math.round((92 * guestZoom * png.width) / content.width),
    y: Math.round((67 * guestZoom * png.height) / content.height)
  }
  const measurements = {
    content,
    guestZoom,
    imageSize: { width: png.width, height: png.height },
    point
  }
  if (
    !Number.isInteger(point.x) ||
    !Number.isInteger(point.y) ||
    point.x < 2 ||
    point.y < 2 ||
    point.x >= png.width - 2 ||
    point.y >= png.height - 2
  ) {
    recordFallbackDiagnostic(diagnostics, { status: 'point-outside-image', ...measurements })
    return null
  }
  const offset = (point.y * png.width + point.x) * 4
  const proofRgb = [png.data[offset], png.data[offset + 1], png.data[offset + 2]]
  recordFallbackDiagnostic(diagnostics, { status: 'sample-ready', ...measurements, proofRgb })
  return {
    source,
    bytes,
    sourceSha: createHash('sha256').update(source).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    proofImagePoint: point,
    proofRgb
  }
}
