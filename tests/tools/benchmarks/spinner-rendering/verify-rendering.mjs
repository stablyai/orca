import assert from 'node:assert/strict'
import { verifyPixels } from './verify-pixels.mjs'

async function waitForPhase(page) {
  await page
    .waitForFunction(() =>
      [...document.querySelectorAll('[data-agent-spinner]')].every((element) => {
        const animations = element.getAnimations({ subtree: true })
        // Offscreen rings must hold no animation; onscreen ones run on the shared phase.
        if (element.hasAttribute('data-animation-offscreen')) {
          return animations.length === 0
        }
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

// Visibility comes from geometry, independent of the marker under test.
async function waitForScrollState(page, expectVisible) {
  await page.waitForFunction((wantVisible) => {
    const scroller = document.querySelector('#scroller').getBoundingClientRect()
    const rings = [...document.querySelectorAll('[data-agent-spinner]')]
    const visible = rings.filter((ring) => {
      const rect = ring.getBoundingClientRect()
      return rect.bottom > scroller.top && rect.top < scroller.bottom
    })
    if (visible.length > 0 !== wantVisible) {
      return false
    }
    return rings.every((ring) => {
      const animations = ring.getAnimations()
      if (visible.includes(ring)) {
        return (
          !ring.hasAttribute('data-animation-offscreen') &&
          animations.length === 1 &&
          animations[0].startTime === 0 &&
          animations[0].playState === 'running'
        )
      }
      return ring.hasAttribute('data-animation-offscreen') && animations.length === 0
    })
  }, expectVisible)
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
  await page.waitForFunction(
    () => document.querySelectorAll('[data-agent-spinner][data-animation-offscreen]').length === 200
  )
  await waitForPhase(page)
  for (const [scrollTop, expectVisible] of [
    [5000, true],
    [0, false],
    [5000, true]
  ]) {
    await page.evaluate((value) => {
      document.querySelector('#scroller').scrollTop = value
    }, scrollTop)
    await waitForScrollState(page, expectVisible)
  }
  // Track a ring that was running before the hide: it must stop, then restart on the shared phase.
  await page.evaluate(() => {
    const scroller = document.querySelector('#scroller').getBoundingClientRect()
    const ring = [...document.querySelectorAll('[data-agent-spinner]')].find((element) => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > scroller.top && rect.top < scroller.bottom
    })
    ring.id = 'tracked-ring'
    document.querySelector('#grid').style.display = 'none'
  })
  await page.waitForFunction(() => {
    const ring = document.querySelector('#tracked-ring')
    return ring.hasAttribute('data-animation-offscreen') && ring.getAnimations().length === 0
  })
  await page.evaluate(() => {
    document.querySelector('#grid').style.display = 'grid'
  })
  await page.waitForFunction(() => {
    const ring = document.querySelector('#tracked-ring')
    const animations = ring.getAnimations()
    return (
      !ring.hasAttribute('data-animation-offscreen') &&
      animations.length === 1 &&
      animations[0].startTime === 0 &&
      animations[0].playState === 'running'
    )
  })
  await waitForPhase(page)
  await page.evaluate(() => window.spinnerBenchmark.render({ count: 4, paired: true }))
  await waitForPhase(page)
  const { candidateSteps, ...iterationEvents } = await page.evaluate(async () => {
    const events = { baseline: 0, candidate: 0, candidateSteps: 0 }
    // Read the live transform without seeking: the candidate must keep stepping.
    const candidate = document.querySelector('[data-agent-spinner]')
    let lastTransform = getComputedStyle(candidate).transform
    const sampler = setInterval(() => {
      const transform = getComputedStyle(candidate).transform
      if (transform !== lastTransform) {
        events.candidateSteps++
        lastTransform = transform
      }
    }, 10)
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
      clearInterval(sampler)
      document.removeEventListener('animationiteration', count, true)
    }
    return events
  })
  assert.ok(iterationEvents.baseline >= 2)
  assert.equal(iterationEvents.candidate, 0)
  // 12 steps/s over 1.25 s is 15 steps; allow for a frame or two lost to scheduling.
  assert.ok(candidateSteps >= 12, `candidate ring stepped ${candidateSteps} times in 1.25 s`)
  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  )
  return {
    pixelComparisons,
    offscreenPause: true,
    iterationEvents,
    candidateSteps,
    phases: true,
    reducedMotion: true,
    scrollReveal: true,
    displayReveal: true,
    hiddenWindow: true
  }
}
