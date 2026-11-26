import type { Page } from '@playwright/test'
import { startHiddenRendererFrameCapture as startCapture } from '../../../../src/main/browser/electron-fixtures/hidden-renderer-frame-capture-fixture'
import './orca-app'
import { expect } from '@stablyai/playwright-test'

export async function startHiddenRendererFrameCapture(page: Page): Promise<() => Promise<void>> {
  return startCapture(page, async (hasFrame) => {
    await expect.poll(hasFrame).toBe(true)
  })
}
