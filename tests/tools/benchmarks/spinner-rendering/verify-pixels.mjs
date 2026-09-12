import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

const TIMES = [
  ...Array.from({ length: 12 }, (_, step) => (step * 1000) / 12 + 1),
  3_600_251,
  43_200_251,
  86_399_751,
  86_399_999,
  86_400_001,
  86_400_251
]

async function captureRingPixels(page, time) {
  await page.evaluate(async (value) => {
    const animations = document.getAnimations()
    for (const animation of animations) {
      animation.pause()
    }
    await Promise.all(animations.map((animation) => animation.ready))
    for (const animation of animations) {
      animation.currentTime = value
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, time)
  const screenshot = await page.screenshot()
  const full = PNG.sync.read(screenshot)
  const rect = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.spinner-cell')].map((element) =>
      element.getBoundingClientRect()
    )
    const scale = window.devicePixelRatio
    const x = Math.floor(cells[0].x * scale)
    const y = Math.floor(cells[0].y * scale)
    return {
      x,
      y,
      width: Math.ceil(cells.at(-1).right * scale) - x,
      height: Math.ceil(cells[0].bottom * scale) - y
    }
  })
  const rings = new PNG({ width: rect.width, height: rect.height })
  PNG.bitblt(full, rings, rect.x, rect.y, rect.width, rect.height, 0, 0)
  return { rings, screenshot }
}

export async function verifyPixels(app, page, outputDir, waitForPhase) {
  let comparisons = 0
  const [minimumZoom, maximumZoom] = await page.evaluate(() => window.spinnerBenchmark.zoomExtremes)
  for (const zoom of [minimumZoom, 1, 1.25, 2, maximumZoom]) {
    await app.evaluate(
      ({ BrowserWindow }, value) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
      zoom
    )
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
        theme
      )
      await page.evaluate(() => window.spinnerBenchmark.render({ count: 4, baseline: true }))
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-baseline]')].every(
          (element) => element.getAnimations()[0]?.startTime === 0
        )
      )
      const baseline = []
      for (const time of TIMES) {
        baseline.push((await captureRingPixels(page, time)).rings)
      }
      await page.evaluate(() => window.spinnerBenchmark.render({ count: 4 }))
      await waitForPhase(page)
      for (const [index, time] of TIMES.entries()) {
        const { rings, screenshot } = await captureRingPixels(page, time)
        const before = baseline[index]
        assert.equal(rings.width, before.width)
        assert.equal(rings.height, before.height)
        let maxDifference = 0
        for (let channel = 0; channel < rings.data.length; channel++) {
          maxDifference = Math.max(
            maxDifference,
            Math.abs(rings.data[channel] - before.data[channel])
          )
        }
        if (maxDifference > 1) {
          writeFileSync(path.join(outputDir, 'pixel-before.png'), PNG.sync.write(before))
          writeFileSync(path.join(outputDir, 'pixel-after.png'), PNG.sync.write(rings))
        }
        // Equivalent accumulated angles can round an antialias channel by one level.
        assert.ok(
          maxDifference <= 1,
          `Pixel difference ${maxDifference} at zoom ${zoom}, ${theme}, time ${time}`
        )
        comparisons += 4
        if (time === TIMES[1] && zoom === 1) {
          writeFileSync(path.join(outputDir, `${theme}.png`), screenshot)
        }
      }
    }
  }
  return comparisons
}
