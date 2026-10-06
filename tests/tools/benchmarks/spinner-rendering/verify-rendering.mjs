import assert from 'node:assert/strict'
import { verifyPixels } from './verify-pixels.mjs'

async function waitForPhase(page) {
  await page
    .waitForFunction(() =>
      [...document.querySelectorAll('[data-agent-spinner]')].every((element) => {
        const animations = element.getAnimations({ subtree: true })
        return (
          animations.length === 1 &&
          animations[0].startTime === 0 &&
          animations[0].playState === 'running'
        )
      })
    )
    .catch(async (error) => {
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll('[data-agent-spinner]')].slice(0, 3).map((element) => ({
            html: element.outerHTML,
            width: getComputedStyle(element).width,
            state: document.visibilityState,
            animations: element.getAnimations({ subtree: true }).map((animation) => ({
              name: animation.animationName,
              start: animation.startTime,
              time: animation.currentTime
            }))
          }))
        )
      )
      throw error
    })
}

export async function verifyRendering(app, page, outputDir) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => window.spinnerBenchmark.render({ count: 4, paired: true }))
  await waitForPhase(page)
  const pixelComparisons = await verifyPixels(app, page, outputDir, waitForPhase)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-agent-spinner]')].every((element) => {
      const ring = getComputedStyle(element)
      return (
        element.getAnimations({ subtree: true }).length === 0 &&
        ring.borderTopColor === ring.borderLeftColor
      )
    })
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await waitForPhase(page)
  await page.evaluate(() => window.spinnerBenchmark.render({ count: 200, offset: 5000 }))
  await waitForPhase(page)
  await page.evaluate(() => {
    document.querySelector('#scroller').scrollTop = 5000
  })
  await waitForPhase(page)
  await page.evaluate(() => {
    document.querySelector('#scroller').scrollTop = 0
  })
  await waitForPhase(page)
  await page.evaluate(() => {
    document.querySelector('#scroller').scrollTop = 5000
  })
  await waitForPhase(page)
  await page.evaluate(() => {
    document.querySelector('#grid').style.display = 'none'
  })
  await page.waitForFunction(
    () => document.querySelector('#grid').getBoundingClientRect().height === 0
  )
  await page.evaluate(() => {
    document.querySelector('#grid').style.display = 'grid'
  })
  await waitForPhase(page)
  const iterationEvents = await page.evaluate(async () => {
    window.spinnerBenchmark.render({ count: 4, paired: true })
    const events = { baseline: 0, candidate: 0 }
    const count = (event) => {
      if (event.animationName === 'spinner-benchmark-spin') {
        events.baseline++
      }
      if (event.animationName === 'agent-spinner-rotate') {
        events.candidate++
      }
    }
    document.addEventListener('animationiteration', count, true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1250))
    } finally {
      document.removeEventListener('animationiteration', count, true)
    }
    return events
  })
  assert.ok(iterationEvents.baseline >= 2)
  assert.equal(iterationEvents.candidate, 0)
  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  )
  return {
    pixelComparisons,
    iterationEvents,
    phases: true,
    reducedMotion: true,
    scrollReveal: true,
    displayReveal: true,
    hiddenWindow: true
  }
}
