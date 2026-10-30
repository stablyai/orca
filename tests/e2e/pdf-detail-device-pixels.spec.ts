import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import {
  buildPdfScalePreferenceKey,
  PDF_SCALE_PREFERENCES_STORAGE_KEY
} from '../../src/renderer/src/components/editor/pdf-scale-preference-storage'

test.use({ orcaAppExtraArgs: ['--force-device-scale-factor=1'] })

test('PDF detail tiles keep device resolution after consecutive capped zooms and scrolling', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  // The canvas cap is screen-relative; keep its trigger independent of the host display.
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    screenWidth: 1920,
    screenHeight: 1050,
    deviceScaleFactor: 1,
    mobile: false
  })
  const filePath = path.join(seededRepoPath, 'pdf-detail-device-pixels.pdf')
  writeFileSync(filePath, createPdfFindFixture())
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Missing fixture worktree')
  }
  const preferenceKey = buildPdfScalePreferenceKey({ worktreeId, filePath })
  await orcaPage.evaluate(
    ({ filePath, worktreeId, preferenceKey, storageKey }) => {
      localStorage.setItem(storageKey, JSON.stringify({ [preferenceKey]: 1 }))
      window.__store?.getState().openFile({
        filePath,
        relativePath: 'pdf-detail-device-pixels.pdf',
        worktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { filePath, worktreeId, preferenceKey, storageKey: PDF_SCALE_PREFERENCES_STORAGE_KEY }
  )
  const page = orcaPage.locator('.pdfViewer .page').first()
  const canvas = page.locator('.canvasWrapper > canvas').last()
  await expect(page.locator('.textLayer')).toContainText('needle result 1')
  expect(await orcaPage.evaluate(() => devicePixelRatio)).toBe(1)

  // Each completed capped step preserves the earlier page rounding before the next zoom.
  for (let step = 0; step < 6; step += 1) {
    const previous = await canvas.elementHandle()
    if (!previous) {
      throw new Error('Missing rendered canvas')
    }
    await orcaPage.getByTitle('Zoom in', { exact: true }).click()
    await expect.poll(() => canvas.evaluate((current, old) => current !== old, previous)).toBe(true)
    await expect(page).not.toHaveClass(/loadingIcon/)
    await previous.dispose()
  }
  await expect(orcaPage.getByText('381%', { exact: true })).toBeVisible()
  await expect(page.locator('.canvasWrapper > canvas')).toHaveCount(2)

  const observations: object[] = []
  const checkTile = async (): Promise<void> => {
    const geometry = await canvas.evaluate((element) => {
      if (!(element instanceof HTMLCanvasElement)) {
        throw new Error('Missing detail canvas')
      }
      const bounds = element.getBoundingClientRect()
      const wrapper = element.parentElement?.getBoundingClientRect()
      if (!wrapper) {
        throw new Error('Missing canvas wrapper')
      }
      const actualDPR = devicePixelRatio
      return {
        actualDPR,
        backing: [element.width, element.height],
        displayed: [bounds.width * actualDPR, bounds.height * actualDPR],
        offset: [(bounds.left - wrapper.left) * actualDPR, (bounds.top - wrapper.top) * actualDPR]
      }
    })
    // CSS rects use 1/64px layout units; relative origins combine two rect measurements.
    const layoutQuantum = geometry.actualDPR / 64
    for (let axis = 0; axis < 2; axis += 1) {
      expect(Math.abs(geometry.displayed[axis] - geometry.backing[axis])).toBeLessThanOrEqual(
        layoutQuantum + 1e-7
      )
      expect(
        Math.abs(geometry.offset[axis] - Math.round(geometry.offset[axis]))
      ).toBeLessThanOrEqual(2 * layoutQuantum + 1e-7)
    }
    observations.push(geometry)
  }
  await checkTile()
  const previous = await canvas.elementHandle()
  if (!previous) {
    throw new Error('Missing rendered detail canvas')
  }
  await page.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('Missing PDF page element')
    }
    const container = element.closest('.pdfViewer')?.parentElement
    if (!container) {
      throw new Error('Missing PDF scroll container')
    }
    container.scrollLeft = container.scrollWidth
    container.scrollTop = element.offsetTop + element.clientHeight - container.clientHeight
  })
  await expect.poll(() => canvas.evaluate((current, old) => current !== old, previous)).toBe(true)
  await expect(page).not.toHaveClass(/loadingIcon/)
  await previous.dispose()
  await checkTile()
  writeFileSync(testInfo.outputPath('detail-geometry.json'), JSON.stringify(observations, null, 2))
})
