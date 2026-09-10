import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@stablyai/playwright-test'

export async function startBrowserProofPage(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><body style="font-family:system-ui;background:#f4f0e8;color:#171717;padding:48px"><h1>Maestro exact Browser</h1><p>Same live Browser surface, rendered inside the Canvas.</p></body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/maestro-browser-proof`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

export async function fitCanvas(page: Page): Promise<void> {
  await page.waitForTimeout(220)
  await page.getByLabel('Fit resources').click()
  await page.waitForTimeout(380)
  await page.getByLabel('Fit resources').click()
  await page.waitForTimeout(380)
}

export async function revealSurfaceAtReadableScale(
  page: Page,
  surface: Locator,
  minimumWidth: number
): Promise<void> {
  const canvas = page.locator('[data-maestro-workspace-canvas]')
  const maximumZoomSteps = 18
  for (let attempt = 0; attempt <= maximumZoomSteps; attempt += 1) {
    const [surfaceBounds, canvasBounds] = await Promise.all([
      surface.boundingBox(),
      canvas.boundingBox()
    ])
    const fullyVisible = Boolean(
      surfaceBounds &&
      canvasBounds &&
      surfaceBounds.x >= canvasBounds.x + 12 &&
      surfaceBounds.x + surfaceBounds.width <= canvasBounds.x + canvasBounds.width - 12 &&
      surfaceBounds.y >= canvasBounds.y + 12 &&
      surfaceBounds.y + surfaceBounds.height <= canvasBounds.y + canvasBounds.height - 12
    )
    if (fullyVisible && surfaceBounds && surfaceBounds.width >= minimumWidth) {
      await page.waitForTimeout(380)
      return
    }
    if (attempt === maximumZoomSteps) {
      break
    }
    await surface.evaluate((element) => {
      const active = document.activeElement
      if (active instanceof HTMLElement) {
        active.blur()
      }
      ;(element as HTMLElement).focus()
    })
    await page.waitForTimeout(380)
    if (surfaceBounds && surfaceBounds.width < minimumWidth) {
      await page.getByLabel('Zoom in').click()
      await page.waitForTimeout(120)
    }
  }
  throw new Error(`Canvas surface did not become readable at ${minimumWidth}px`)
}
