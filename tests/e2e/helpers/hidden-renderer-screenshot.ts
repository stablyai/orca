import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  guardScreenshotAgainstMachineIdentity,
  type ScreenshotIdentityGuardRecord
} from './screenshot-machine-identity-guard'

/**
 * Captures a never-shown window straight from its renderer over CDP, after animations settle.
 * Records a `<file>.identity-guard.json` beside it and refuses, writing no PNG, when the
 * renderer's text or terminal buffers show this machine's username, hostname or home path.
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
    const body = Buffer.from(data, 'base64')
    writeFileSync(filePath, body)
    return body
  } finally {
    await cdp.detach()
  }
}
