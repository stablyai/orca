import type { Page } from '@playwright/test'
import { startHiddenRendererFrameCapture as startCapture } from '../../../src/main/browser/hidden-renderer-frame-capture-fixture'
import { expect } from './orca-app'

export async function startHiddenRendererFrameCapture(page: Page): Promise<() => Promise<void>> {
  return startCapture(page, async (hasFrame) => {
    await expect.poll(hasFrame).toBe(true)
  })
}
