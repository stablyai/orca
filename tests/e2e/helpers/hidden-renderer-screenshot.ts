import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  guardScreenshotAgainstMachineIdentity,
  type ScreenshotIdentityGuardRecord
} from './screenshot-machine-identity-guard'

/**
 * Captures a never-shown window straight from its renderer over CDP, after animations settle.
 * Records a `<file>.identity-guard.json` beside it and refuses, writing no PNG, when the
 * renderer's text or terminal buffers show this machine's username, hostname or home path, or
 * when the guard's read came back blank or missed a rendered terminal.
 */
export async function captureHiddenRendererScreenshot(
  page: Page,
  filePath: string
): Promise<Buffer> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))
    )
    const screenshot = path.basename(filePath)
    const before = await guardScreenshotAgainstMachineIdentity(page, screenshot)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const after = await guardScreenshotAgainstMachineIdentity(page, screenshot)
    const guard: ScreenshotIdentityGuardRecord = {
      ...after,
      evidenceGaps: [...new Set([...before.evidenceGaps, ...after.evidenceGaps])],
      leaks: [...new Set([...before.leaks, ...after.leaks])]
    }
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(`${filePath}.identity-guard.json`, `${JSON.stringify(guard, null, 2)}\n`)
    if (guard.leaks.length > 0) {
      rmSync(filePath, { force: true })
      throw new Error(
        `Refusing ${screenshot}: the renderer shows this machine's ${guard.leaks.join(', ')}`
      )
    }
    if (guard.evidenceGaps.length > 0) {
      rmSync(filePath, { force: true })
      throw new Error(
        `Refusing ${screenshot}: the guard's read was incomplete (${guard.evidenceGaps.join(', ')})`
      )
    }
    const body = Buffer.from(data, 'base64')
    writeFileSync(filePath, body)
    return body
  } finally {
    await cdp.detach()
  }
}

/**
 * Stands in for Playwright's failure screenshot, which bypasses the identity guard: captures each
 * page as `test-failed-<n>.png` through it. A refused capture leaves its guard record and a text
 * attachment naming the refusal, so the test's own error stays the reported failure.
 */
export async function captureGuardedFailureScreenshots(
  pages: Page[],
  testInfo: TestInfo
): Promise<void> {
  for (const [index, page] of pages.entries()) {
    const file = `test-failed-${index + 1}.png`
    await captureHiddenRendererScreenshot(page, testInfo.outputPath(file)).then(
      (body) => testInfo.attach(file, { body, contentType: 'image/png' }),
      (error: Error) =>
        testInfo.attach(`${file} refused`, { body: error.message, contentType: 'text/plain' })
    )
  }
}
