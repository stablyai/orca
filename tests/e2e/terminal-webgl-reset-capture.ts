import type { Buffer } from 'node:buffer'
import type { Page } from '@stablyai/playwright-test'
import { captureGraySlabAnalysis, type GraySlabAnalysis } from './terminal-raster-artifact-analysis'

export async function resetWebglAndCaptureGraySlabAnalysis(page: Page): Promise<{
  analysis: GraySlabAnalysis
  screenshot: Buffer
}> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    manager?.resetWebglTextureAtlases?.()
    pane?.terminal?.refresh?.(0, Math.max(0, (pane.terminal.rows ?? 1) - 1))
  })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  return captureGraySlabAnalysis(page)
}
