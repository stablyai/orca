import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

async function forceWebgl(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: {
        ...state.settings,
        terminalGpuAcceleration: 'on'
      }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    manager?.setTerminalGpuAcceleration('on')
  })
  return page
    .waitForFunction(
      () => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const diagnostics = tabId
          ? (window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? [])
          : []
        return diagnostics.some((diagnostic) => diagnostic.hasWebgl)
      },
      null,
      { timeout: 5_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function writeStableTerminalContent(page: Page): Promise<void> {
  await page.evaluate(async () => {
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
    if (!pane) {
      throw new Error('Active terminal pane is unavailable')
    }
    const panes = manager?.getPanes?.() ?? (pane ? [pane] : [])
    if (panes.length === 0) {
      throw new Error('Terminal panes are unavailable')
    }
    for (const [paneIndex, targetPane] of panes.entries()) {
      const rows = Array.from(
        { length: 12 },
        (_, row) =>
          `VISIBILITY_WEBGL_RECOVERY pane ${paneIndex} row ${String(row).padStart(2, '0')} abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\`
      )
      await new Promise<void>((resolve) =>
        targetPane.terminal.write(`\x1b[2J\x1b[3J\x1b[H\x1b[?25l${rows.join('\r\n')}`, resolve)
      )
      targetPane.terminal.refresh(0, targetPane.terminal.rows - 1)
    }
  })
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function patchAtlasCounter(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const panes = [
      ...((
        manager as unknown as
          | { panes?: Map<number, { webglAddon?: { clearTextureAtlas: () => void } | null }> }
          | undefined
      )?.panes?.values?.() ?? [])
    ]
    const webglAddons = panes
      .map((pane) => pane.webglAddon)
      .filter((webglAddon): webglAddon is { clearTextureAtlas: () => void } => Boolean(webglAddon))
    if (webglAddons.length === 0) {
      return false
    }
    const globalWithCounter = window as typeof window & {
      __documentVisibilityAtlasResetCount?: number
    }
    globalWithCounter.__documentVisibilityAtlasResetCount = 0
    for (const webglAddon of webglAddons) {
      const originalClearTextureAtlas = webglAddon.clearTextureAtlas.bind(webglAddon)
      webglAddon.clearTextureAtlas = () => {
        globalWithCounter.__documentVisibilityAtlasResetCount =
          (globalWithCounter.__documentVisibilityAtlasResetCount ?? 0) + 1
        originalClearTextureAtlas()
      }
    }
    return true
  })
}

async function countPatchedWebglAddons(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    return [
      ...((
        manager as unknown as
          | { panes?: Map<number, { webglAddon?: { clearTextureAtlas: () => void } | null }> }
          | undefined
      )?.panes?.values?.() ?? [])
    ].filter((pane) => pane.webglAddon).length
  })
}

async function readAtlasResetCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const globalWithCounter = window as typeof window & {
      __documentVisibilityAtlasResetCount?: number
    }
    return globalWithCounter.__documentVisibilityAtlasResetCount ?? 0
  })
}

async function resetAtlasResetCount(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globalWithCounter = window as typeof window & {
      __documentVisibilityAtlasResetCount?: number
    }
    globalWithCounter.__documentVisibilityAtlasResetCount = 0
  })
}

async function waitForTerminalPaint(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function terminalScreenshots(page: Page): Promise<Buffer[]> {
  const screens = page.locator('.xterm-screen')
  const count = await screens.count()
  const screenshots: Buffer[] = []
  for (let index = 0; index < count; index += 1) {
    const screen = screens.nth(index)
    await expect(screen).toBeVisible()
    screenshots.push(await screen.screenshot({ animations: 'disabled' }))
  }
  return screenshots
}

function countTerminalInkPixels(buffer: Buffer): number {
  const image = PNG.sync.read(buffer)
  const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>()
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] ?? 0
    if (alpha < 128) {
      continue
    }
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const key = `${red >> 3},${green >> 3},${blue >> 3}`
    const bucket = buckets.get(key) ?? { count: 0, red, green, blue }
    bucket.count += 1
    buckets.set(key, bucket)
  }
  const background = [...buckets.values()].sort((a, b) => b.count - a.count)[0]
  if (!background) {
    return 0
  }
  let inkPixels = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] ?? 0
    if (alpha < 128) {
      continue
    }
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const distance =
      Math.abs(red - background.red) +
      Math.abs(green - background.green) +
      Math.abs(blue - background.blue)
    if (distance > 48) {
      inkPixels += 1
    }
  }
  return inkPixels
}

async function showBrowserWindow(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('No BrowserWindow available')
    }
    if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
  })
}

async function tryBrowserWindowVisibilityCycle(
  electronApp: ElectronApplication,
  page: Page
): Promise<boolean> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('No BrowserWindow available')
    }
    window.hide()
  })
  await page.waitForTimeout(500)
  const becameHidden = await page.evaluate(() => document.visibilityState === 'hidden')
  await showBrowserWindow(electronApp)
  await page.waitForTimeout(500)
  return becameHidden && (await page.evaluate(() => document.visibilityState === 'visible'))
}

async function dispatchDocumentVisibilityCycle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const setVisibilityState = (visibilityState: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState
      })
    }

    try {
      setVisibilityState('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      setVisibilityState('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      // Why: the e2e harness may not naturally report hidden visibility, so
      // restore the document to the visible state expected by later cleanup.
      setVisibilityState('visible')
    }
  })
}

test.describe('terminal document visibility WebGL recovery @headful', () => {
  test('clears the WebGL atlas and keeps terminal text painted after document visibility resumes', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    const webglActive = await forceWebgl(orcaPage)
    test.skip(!webglActive, 'WebGL was not active in this headful environment')

    await writeStableTerminalContent(orcaPage)
    expect(await patchAtlasCounter(orcaPage)).toBe(true)
    expect(await countPatchedWebglAddons(orcaPage)).toBeGreaterThanOrEqual(2)
    const baseline = await terminalScreenshots(orcaPage)
    expect(baseline.length).toBeGreaterThanOrEqual(2)
    const baselineInkPixels = baseline.map(countTerminalInkPixels)
    for (const inkPixels of baselineInkPixels) {
      expect(inkPixels).toBeGreaterThan(1_000)
    }

    try {
      // Why: this is the app-level background/foreground path where the
      // TerminalPane stays mounted and visible, so React pane visibility does
      // not run its normal resume recovery.
      await resetAtlasResetCount(orcaPage)
      const browserWindowVisibilityWorked = await tryBrowserWindowVisibilityCycle(
        electronApp,
        orcaPage
      )
      console.log(
        `[visibility-webgl] browserWindowVisibilityWorked=${browserWindowVisibilityWorked}`
      )
      if (browserWindowVisibilityWorked) {
        await expect
          .poll(() => readAtlasResetCount(orcaPage), {
            timeout: 2_000,
            message: 'BrowserWindow visibility resume did not clear the WebGL atlas'
          })
          .toBeGreaterThan(0)
      } else {
        await resetAtlasResetCount(orcaPage)
        await dispatchDocumentVisibilityCycle(orcaPage)
        await expect
          .poll(() => readAtlasResetCount(orcaPage), {
            timeout: 2_000,
            message: 'document visibility resume did not clear the WebGL atlas'
          })
          .toBeGreaterThan(0)
      }

      await waitForTerminalPaint(orcaPage)

      const afterResume = await terminalScreenshots(orcaPage)
      for (const [index, baselineShot] of baseline.entries()) {
        await testInfo.attach(`visibility-webgl-baseline-${index}`, {
          body: baselineShot,
          contentType: 'image/png'
        })
      }
      for (const [index, afterResumeShot] of afterResume.entries()) {
        await testInfo.attach(`visibility-webgl-after-resume-${index}`, {
          body: afterResumeShot,
          contentType: 'image/png'
        })
      }
      expect(afterResume.length).toBe(baseline.length)
      const afterResumeInkPixels = afterResume.map(countTerminalInkPixels)
      for (const [index, inkPixels] of afterResumeInkPixels.entries()) {
        expect(
          inkPixels,
          `terminal glyph pixels disappeared after visibility resume in pane ${index}`
        ).toBeGreaterThanOrEqual(Math.floor((baselineInkPixels[index] ?? 0) * 0.85))
      }
    } finally {
      await showBrowserWindow(electronApp).catch(() => {})
    }
  })
})
