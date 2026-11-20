import assert from 'node:assert/strict'

const render = (page, scenario) =>
  page.evaluate((value) => window.spinnerBenchmark.render(value), scenario)
const census = (page) => page.evaluate(() => window.spinnerBenchmark.census())
const rotating = (indicators) =>
  indicators.filter(
    (indicator) => indicator.name === 'spin' || indicator.name === 'agent-spinner-rotate'
  )
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function stepsSeen(page, durationMs) {
  const turns = new Set()
  for (let elapsed = 0; elapsed < durationMs; elapsed += 250) {
    turns.add(rotating(await census(page))[0].turn)
    await pause(250)
  }
  return turns.size
}

/** Checks what the user sees: indicators step together beside a ticking label and hold still otherwise. */
export async function verifyRendering(app, page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // Nothing ever runs, from the first moment: four rings, two loaders, one pulsing label per agent.
  await render(page, { agents: 2, label: 'ticking' })
  const mounted = await census(page)
  assert.equal(mounted.filter((item) => item.name === 'agent-spinner-rotate').length, 8)
  assert.equal(mounted.filter((item) => item.name === 'spin').length, 4)
  assert.equal(mounted.filter((item) => item.name === 'pulse').length, 2)
  assert.ok(mounted.every((item) => item.playState === 'paused'))

  // Beside a ticking label they advance about once a second, all on the same step.
  const beside = await stepsSeen(page, 3000)
  assert.ok(beside >= 3 && beside <= 4, `expected ~3 steps in 3s beside a label, saw ${beside}`)
  const settled = await census(page)
  const spinning = rotating(settled)
  assert.equal(new Set(spinning.map((item) => item.turn)).size, 1, 'one shared step')
  assert.ok(Number.isInteger(spinning[0].turn * 8), 'spinners step in eighths of a turn')
  const pulsing = settled.filter((item) => item.name === 'pulse')
  assert.equal(new Set(pulsing.map((item) => item.turn)).size, 1, 'pulses breathe together')
  assert.ok(Number.isInteger(pulsing[0].turn * 4), 'pulses step in quarters of a cycle')

  // With nothing else repainting they hold still, including beside a label whose text does not change.
  await render(page, { agents: 2 })
  assert.equal(await stepsSeen(page, 2500), 1, 'indicators alone must not move')
  await render(page, { agents: 2, label: 'quiet' })
  assert.equal(await stepsSeen(page, 2500), 1, 'a label that repaints nothing must not move them')

  // Reduced motion: no animation at all, and the ring closes so it reads as intentional.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-agent-spinner]')].every((element) => {
      const ring = getComputedStyle(element)
      return element.getAnimations().length === 0 && ring.borderTopColor === ring.borderLeftColor
    })
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    ),
    'the benchmark window must stay in the background'
  )
  return { neverRunning: true, sharedStep: true, stillWhenAlone: true, reducedMotion: true }
}
