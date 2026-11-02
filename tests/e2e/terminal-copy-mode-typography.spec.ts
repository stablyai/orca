import type { Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { resolveActiveTabId, waitForActiveTerminalManager } from './helpers/terminal'
import { pressShortcut } from './helpers/shortcuts'
import {
  expectCopyCursorReady,
  seedCopyModeScreen,
  startCopyModeTerminalProbe
} from './helpers/terminal-copy-mode-fixture'

type TypographySettings = { gpu: 'on' | 'off'; fontSize: number; lineHeight: number }

async function prepareTypography(
  page: Page,
  settings?: TypographySettings
): Promise<string | null> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await startCopyModeTerminalProbe(page)
  const tabId = await resolveActiveTabId(page)
  if (settings) {
    await page.evaluate(
      async ({ tabId, settings }) => {
        await window.__store?.getState().updateSettingsOrThrow({
          terminalGpuAcceleration: settings.gpu,
          terminalFontSize: settings.fontSize,
          terminalLineHeight: settings.lineHeight
        })
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        manager?.setTerminalGpuAcceleration(settings.gpu)
      },
      { tabId, settings }
    )
    if (settings.gpu === 'on') {
      const available = await page
        .waitForFunction(
          (tabId) => {
            const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
            return Boolean(pane?.terminal.element?.querySelector('.xterm-screen canvas'))
          },
          tabId,
          { timeout: 5000 }
        )
        .then(() => true)
        .catch(() => false)
      test.skip(!available, 'WebGL unavailable in this environment')
    } else {
      await expect
        .poll(() =>
          page.evaluate((tabId) => {
            const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
            return Boolean(pane?.terminal.element?.querySelector('.xterm-screen canvas'))
          }, tabId)
        )
        .toBe(false)
    }
  }
  await seedCopyModeScreen(
    page,
    Array.from({ length: 10 }, () => 'HHHHHHHHHHHHHHHHHHHHHHHH').join('\r\n')
  )
  await page.evaluate((tabId) => {
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    pane?.fitAddon.fit()
  }, tabId)
  return tabId
}

function inkRowStarts(bytes: Buffer): number[] {
  const image = PNG.sync.read(bytes)
  const colors = new Map<number, number>()
  for (let index = 0; index < image.data.length; index += 4) {
    const key = (image.data[index] << 16) | (image.data[index + 1] << 8) | image.data[index + 2]
    colors.set(key, (colors.get(key) ?? 0) + 1)
  }
  const background = [...colors].sort((a, b) => b[1] - a[1])[0][0]
  const starts: number[] = []
  let previous = false
  for (let y = 0; y < image.height; y += 1) {
    let ink = 0
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      const difference =
        Math.abs(image.data[index] - ((background >> 16) & 255)) +
        Math.abs(image.data[index + 1] - ((background >> 8) & 255)) +
        Math.abs(image.data[index + 2] - (background & 255))
      if (difference > 60) {
        ink += 1
      }
    }
    const current = ink > image.width / 20
    if (current && !previous) {
      starts.push(y)
    }
    previous = current
  }
  return starts
}

for (const settings of [
  undefined,
  { gpu: 'on', fontSize: 11, lineHeight: 1 },
  { gpu: 'on', fontSize: 14, lineHeight: 1 },
  { gpu: 'on', fontSize: 13, lineHeight: 1.3 },
  { gpu: 'off', fontSize: 11, lineHeight: 1 },
  { gpu: 'off', fontSize: 14, lineHeight: 1 },
  { gpu: 'off', fontSize: 13, lineHeight: 1.3 }
] as const) {
  const label = settings
    ? `${settings.gpu}, ${settings.fontSize}px, ${settings.lineHeight}`
    : 'profile defaults'
  test(`copy mode preserves rendered cell size and ink row spacing (${label})`, async ({
    orcaPage
  }, testInfo) => {
    const tabId = await prepareTypography(orcaPage, settings)
    const source = await orcaPage.evaluate((tabId) => {
      const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
      const screen = pane?.terminal.element?.querySelector('.xterm-screen')
      const cell = pane?.terminal.dimensions?.css.cell
      if (!pane || !screen || !cell) {
        throw new Error('No source typography')
      }
      const rect = screen.getBoundingClientRect()
      return {
        width: cell.width,
        height: cell.height,
        cols: pane.terminal.cols,
        x: rect.x,
        y: rect.y
      }
    }, tabId)
    const clip = {
      x: source.x + source.width * 2,
      y: source.y,
      width: source.width * 16,
      height: source.height * 6
    }
    const original = await orcaPage.screenshot({
      path: testInfo.outputPath('original-rows.png'),
      clip
    })
    await pressShortcut(orcaPage, 'x', { shift: true })
    await expectCopyCursorReady(orcaPage)
    const copied = await orcaPage.locator('.terminal-copy-mode-cursor').evaluate((element) => ({
      width: Number.parseFloat(element.style.width),
      height: Number.parseFloat(element.style.height)
    }))
    const screen = await orcaPage.locator('.terminal-copy-mode .xterm-screen').boundingBox()
    if (!screen) {
      throw new Error('No copy-mode screen')
    }
    const snapshot = await orcaPage.screenshot({
      path: testInfo.outputPath('copy-rows.png'),
      clip: { ...clip, x: screen.x + source.width * 2, y: screen.y }
    })
    const originalRows = inkRowStarts(original)
    const snapshotRows = inkRowStarts(snapshot)
    console.log('COPY_TYPOGRAPHY', { source, copied, originalRows, snapshotRows })
    expect(originalRows.length).toBeGreaterThanOrEqual(5)
    expect(snapshotRows.length).toBeGreaterThanOrEqual(5)
    expect(snapshotRows.slice(1, 5).map((value, index) => value - snapshotRows[index])).toEqual(
      originalRows.slice(1, 5).map((value, index) => value - originalRows[index])
    )
    expect(snapshotRows.slice(0, 5)).toEqual(originalRows.slice(0, 5))
    expect(copied.height).toBeCloseTo(source.height, 1)
    expect(copied.width).toBeCloseTo(source.width, 1)
    expect(Math.round(screen.width / copied.width)).toBe(source.cols)
    await test.step('rendered spacing after viewport and pixel-ratio change', async () => {
      await orcaPage.setViewportSize({ width: 1100, height: 720 })
      await expectCopyCursorReady(orcaPage)
      await orcaPage.evaluate((tabId) => {
        if (tabId) {
          window.__paneManagers?.get(tabId)?.fitAllPanes()
        }
      }, tabId)
      // ConPTY may repaint the live pane on resize; keep the reference text controlled.
      await seedCopyModeScreen(
        orcaPage,
        Array.from({ length: 10 }, () => 'HHHHHHHHHHHHHHHHHHHHHHHH').join('\r\n')
      )
      const current = await orcaPage.evaluate((tabId) => {
        const terminal = tabId ? window.__paneManagers?.get(tabId)?.getActivePane()?.terminal : null
        const rectangle = terminal?.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
        const cell = terminal?.dimensions?.css.cell
        if (!rectangle || !cell) {
          throw new Error('No resized source typography')
        }
        return { x: rectangle.x, y: rectangle.y, width: cell.width, height: cell.height }
      }, tabId)
      const resizedClip = {
        x: current.x + current.width * 2,
        y: current.y,
        width: current.width * 16,
        height: current.height * 6
      }
      const mode = orcaPage.locator('.terminal-copy-mode')
      await mode.evaluate((root) => {
        root.style.visibility = 'hidden'
      })
      const resizedOriginal = await orcaPage.screenshot({
        path: testInfo.outputPath('resized-original-rows.png'),
        clip: resizedClip
      })
      await mode.evaluate((root) => {
        root.style.visibility = ''
      })
      await mode.locator('.xterm-helper-textarea').focus()
      const resizedScreen = await mode.locator('.xterm-screen').boundingBox()
      if (!resizedScreen) {
        throw new Error('No resized copy-mode screen')
      }
      const resizedSnapshot = await orcaPage.screenshot({
        path: testInfo.outputPath('resized-copy-rows.png'),
        clip: { ...resizedClip, x: resizedScreen.x + current.width * 2, y: resizedScreen.y }
      })
      const expectedRows = inkRowStarts(resizedOriginal)
      const actualRows = inkRowStarts(resizedSnapshot)
      expect(expectedRows.length).toBeGreaterThanOrEqual(5)
      expect(actualRows.slice(0, 5)).toEqual(expectedRows.slice(0, 5))
      const cursor = await mode.locator('.terminal-copy-mode-cursor').evaluate((element) => ({
        width: Number.parseFloat(element.style.width),
        height: Number.parseFloat(element.style.height)
      }))
      expect(cursor.width).toBeCloseTo(current.width, 1)
      expect(cursor.height).toBeCloseTo(current.height, 1)
    })
  })
}

test('copy renderer context loss closes only the snapshot and permits a fresh entry', async ({
  orcaPage
}) => {
  const tabId = await prepareTypography(orcaPage, { gpu: 'on', fontSize: 14, lineHeight: 1 })
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage
    .locator('.terminal-copy-mode .xterm-screen canvas:not(.xterm-link-layer)')
    .evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('No copy renderer canvas')
      }
      const loss = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
      if (!loss) {
        throw new Error('No WebGL context-loss extension')
      }
      loss.loseContext()
    })
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
  const sourceHealthy = () =>
    orcaPage.evaluate((tabId) => {
      const canvas = tabId
        ? window.__paneManagers
            ?.get(tabId)
            ?.getActivePane()
            ?.terminal.element?.querySelector<HTMLCanvasElement>(
              '.xterm-screen canvas:not(.xterm-link-layer)'
            )
        : null
      const context = canvas?.getContext('webgl2')
      return context && !context.isContextLost()
    }, tabId)
  await expect.poll(sourceHealthy).toBe(true)
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.press('q')
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
  await expect.poll(sourceHealthy).toBe(true)
})
