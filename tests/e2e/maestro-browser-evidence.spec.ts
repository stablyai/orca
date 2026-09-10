import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'

async function startNativeBrowserProofPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html><head><style>html,body{background:#fff;color:#111;margin:0}</style></head><body><main><h1>ORC-11 native Browser proof</h1><p>Harness-owned visible page.</p></main></body></html>`
    )
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/orc11-browser-proof`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
  }
}

async function createNativeBrowserTab(
  page: Page,
  url: string
): Promise<{
  browserWorkspaceTabId: string
  browserPageId: string
  worktreeId: string
}> {
  const result = await page.evaluate((targetUrl) => {
    const store = window.__store
    const worktreeId = store?.getState().activeWorktreeId
    if (!store || !worktreeId) {
      return null
    }
    const tab = store.getState().createBrowserTab(worktreeId, targetUrl, {
      title: 'ORC-11 native Browser proof',
      activate: true
    })
    const browserPageId = tab.activePageId
    if (!browserPageId) {
      return null
    }
    return { browserWorkspaceTabId: tab.id, browserPageId, worktreeId }
  }, url)
  if (!result) {
    throw new Error('Could not create the native Browser tab')
  }
  return result
}

async function readNativeBrowserProof(
  page: Page,
  browserWorkspaceTabId: string
): Promise<string | null> {
  return page.evaluate(async (tabId) => {
    const slot = document.querySelector(`[data-browser-overlay-tab-id="${tabId}"]`)
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return null
    }
    try {
      return (await webview.executeJavaScript(
        'document.querySelector("h1")?.textContent ?? null'
      )) as string | null
    } catch {
      return null
    }
  }, browserWorkspaceTabId)
}

async function captureNativeBrowserProof(
  page: Page,
  browserPageId: string
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const encoded = await page.evaluate(async (targetPageId) => {
    const response = await window.api.runtime.call({
      method: 'browser.screenshot',
      params: {
        page: targetPageId,
        format: 'png'
      }
    })
    if (!response.ok) {
      throw new Error(`Native Browser CDP capture failed: ${response.error.message}`)
    }
    const screenshot = response.result as { data?: unknown; format?: unknown }
    if (screenshot.format !== 'png' || typeof screenshot.data !== 'string') {
      throw new Error('Native Browser CDP capture returned an invalid PNG payload')
    }
    return screenshot.data
  }, browserPageId)
  const buffer = Buffer.from(encoded, 'base64')
  const dimensions = validateNativeBrowserProofBitmap(buffer)
  return { buffer, ...dimensions }
}

function validateNativeBrowserProofBitmap(buffer: Buffer): { width: number; height: number } {
  let bitmap: PNG
  try {
    bitmap = PNG.sync.read(buffer)
  } catch (error) {
    throw new Error(`Native Browser proof is not a decodable PNG: ${String(error)}`)
  }
  if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.data.length === 0) {
    throw new Error('Native Browser proof is empty')
  }

  const pixel = (x: number, y: number): [number, number, number, number] => {
    const offset = (y * bitmap.width + x) * 4
    return [
      bitmap.data[offset],
      bitmap.data[offset + 1],
      bitmap.data[offset + 2],
      bitmap.data[offset + 3]
    ]
  }
  const corner = pixel(0, 0)
  const cornerLuma = (corner[0] + corner[1] + corner[2]) / 3
  let minLuma = 255
  let maxLuma = 0
  let inkPixels = 0
  for (let offset = 0; offset < bitmap.data.length; offset += 4) {
    const luma = (bitmap.data[offset] + bitmap.data[offset + 1] + bitmap.data[offset + 2]) / 3
    minLuma = Math.min(minLuma, luma)
    maxLuma = Math.max(maxLuma, luma)
    if (bitmap.data[offset + 3] > 0 && luma < 160) {
      inkPixels += 1
    }
  }

  const headingBandWidth = Math.min(bitmap.width, 900)
  const headingBandHeight = Math.min(bitmap.height, 220)
  let headingInkPixels = 0
  for (let y = 0; y < headingBandHeight; y += 1) {
    for (let x = 0; x < headingBandWidth; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y)
      if (alpha > 0 && (red + green + blue) / 3 < 160) {
        headingInkPixels += 1
      }
    }
  }

  if (cornerLuma < 180 || maxLuma - minLuma < 12 || inkPixels < 100 || headingInkPixels < 20) {
    throw new Error(
      `Native Browser proof failed painted-content validation: ${JSON.stringify({
        width: bitmap.width,
        height: bitmap.height,
        cornerLuma,
        minLuma,
        maxLuma,
        inkPixels,
        headingInkPixels
      })}`
    )
  }
  return { width: bitmap.width, height: bitmap.height }
}

type MaestroReturnState = 'pending' | 'empty' | 'ready'

async function readMaestroReturnState(page: Page): Promise<MaestroReturnState> {
  if (await page.locator('[data-maestro-canvas]').isVisible()) {
    return 'ready'
  }
  if (await page.getByRole('heading', { name: 'No Canvas run', exact: true }).isVisible()) {
    return 'empty'
  }
  return 'pending'
}

test.describe('Maestro browser evidence fixture', () => {
  test('opens paints captures and releases the exact native Browser page before returning to Canvas', async ({
    orcaPage
  }) => {
    const proof = await startNativeBrowserProofPage()
    try {
      const { browserWorkspaceTabId, browserPageId } = await createNativeBrowserTab(
        orcaPage,
        proof.url
      )
      await expect
        .poll(() => readNativeBrowserProof(orcaPage, browserWorkspaceTabId))
        .toBe('ORC-11 native Browser proof')
      const browserOverlay = orcaPage.locator(
        `[data-browser-overlay-tab-id="${browserWorkspaceTabId}"]`
      )
      await expect(browserOverlay).toBeVisible()
      await expect(browserOverlay.locator('webview')).toBeVisible()

      if (process.env.ORC11_CAPTURE_EVIDENCE === '1') {
        const evidenceRoot = resolve('.visual-evidence/maestro-worktree-canvas')
        mkdirSync(evidenceRoot, { recursive: true })
        const nativeProof = await captureNativeBrowserProof(orcaPage, browserPageId)
        writeFileSync(resolve(evidenceRoot, 'orc11-browser-evidence-proof.png'), nativeProof.buffer)
        for (const profile of [
          { id: 'desktop', width: 1920, height: 1080 },
          { id: 'notebook', width: 1366, height: 768 }
        ]) {
          await orcaPage.setViewportSize({ width: profile.width, height: profile.height })
          await orcaPage.screenshot({
            path: resolve(evidenceRoot, `orc11-browser-native-${profile.id}.png`),
            animations: 'disabled',
            caret: 'hide',
            scale: 'css'
          })
        }
      }

      await orcaPage.evaluate((tabId) => {
        const store = window.__store
        store?.getState().closeBrowserTab(tabId)
      }, browserWorkspaceTabId)
      await expect(
        orcaPage.locator(`[data-browser-overlay-tab-id="${browserWorkspaceTabId}"]`)
      ).toHaveCount(0)

      await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
      await orcaPage.getByRole('menuitem', { name: 'Maestro', exact: true }).click({ force: true })
      try {
        await expect
          .poll(() => readMaestroReturnState(orcaPage), { timeout: 10_000 })
          .toMatch(/^(empty|ready)$/)
      } catch (error) {
        const errorCode = await orcaPage
          .locator('[data-maestro-error-code]')
          .getAttribute('data-maestro-error-code')
        throw new Error(
          `Maestro return did not reach No Canvas run or a ready Canvas; data-maestro-error-code=${errorCode ?? 'missing'}; ${String(error)}`
        )
      }
    } finally {
      await proof.close()
    }
  })
})
