import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'

/** Captures a never-shown window straight from its renderer over CDP, after animations settle. */
export async function captureHiddenRendererScreenshot(
  page: Page,
  filePath: string
): Promise<Buffer> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))
    )
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const body = Buffer.from(data, 'base64')
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, body)
    return body
  } finally {
    await cdp.detach()
  }
}
