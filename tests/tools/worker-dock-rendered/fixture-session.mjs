// The fixture page the worker dock suite drives: one warm headless page per touch mode, a scene
// loader, and the PASS/FAIL bookkeeping. Imported by run.mjs.
import { chromium } from 'playwright-core'

// The worker pill and card as the checks read them.
export const toggle = (page) => page.locator('[data-worker-dock-pill]')
export const card = (page) => page.locator('[data-worker-dock-card]')
// The chip's visible box, folded or open (the toggle sits inside its border).
export const chip = (page) => page.locator('[data-worker-dock-morph]')
export const region = (page) => page.locator('[data-worker-dock-card] [role="region"]')
export const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-worker-dock-row]')].map((row) => ({
      id: row.getAttribute('data-worker-dock-row'),
      state: row.getAttribute('data-worker-dock-state') ?? ''
    }))
  )
export const scrollState = (page) =>
  region(page).evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight
  }))
export const events = (page) => page.evaluate(() => window.__workerDockHarness?.events ?? [])
export const expanded = async (page) =>
  (await toggle(page).getAttribute('aria-expanded')) === 'true'
export const focusedRow = (page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-worker-dock-row]')
        ?.getAttribute('data-worker-dock-row') ?? null
  )

export async function createFixtureSession({ base, filter, fixture: FIXTURE }) {
  const results = []
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ORCA_FIXTURES_BROWSER
  })

  const pages = new Map()
  async function warmPage(touch) {
    if (!pages.has(touch)) {
      const context = await browser.newContext({ hasTouch: touch })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      const opened = { page, errors: [], revision: 0 }
      page.on('pageerror', (error) => opened.errors.push(error.message))
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          opened.revision++
        }
      })
      await page.goto(`${base}/fixtures.html?worker=1`, {
        waitUntil: 'commit',
        timeout: 180_000
      })
      pages.set(touch, opened)
    }
    const opened = pages.get(touch)
    try {
      await opened.page.waitForFunction(
        () => Boolean(window.__orcaComponentFixtureHost),
        undefined,
        {
          timeout: 60_000
        }
      )
    } catch (error) {
      const detail = opened.errors.join(', ') || error.message.split('\n')[0]
      throw new Error(`Fixture host at ${base} did not start: ${detail}`, { cause: error })
    }
    return opened
  }

  async function open(
    scene,
    { width = 760, height = 900, theme = 'dark', touch = false, fixture = FIXTURE } = {}
  ) {
    const opened = await warmPage(touch)
    const { page, errors } = opened
    errors.length = 0
    await page.setViewportSize({ width, height })
    await page.evaluate(
      ([id, fixtureTheme]) => window.__orcaComponentFixtureHost.render(id, fixtureTheme),
      [`${fixture}:${scene}`, theme]
    )
    await page.waitForFunction(
      () => ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? ''),
      undefined,
      { timeout: 60_000 }
    )
    const failure = await page.evaluate(() => document.documentElement.dataset.fixtureError)
    assert(!failure, failure)
    return opened
  }

  async function check(name, run) {
    if (filter && !name.includes(filter)) {
      return
    }
    try {
      await run()
      results.push({ name, ok: true })
      console.log(`PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false })
      console.error('FAIL ', name, '->', error.message)
    }
  }
  function assert(condition, message) {
    if (!condition) {
      throw new Error(message)
    }
  }
  async function scene(name, options, run) {
    const opened = await warmPage(options.touch ?? false)
    const revision = opened.revision
    try {
      await open(name, options)
      await run(opened.page)
      assert(opened.revision === revision, 'fixture server reloaded during the case')
      assert(opened.errors.length === 0, `page errors: ${opened.errors.join(', ')}`)
    } catch (error) {
      if (opened.revision === revision) {
        throw error
      }
      // A source edit can reload the fixture document between browser actions.
      const retry = await open(name, options)
      const retryRevision = retry.revision
      await run(retry.page)
      assert(retry.revision === retryRevision, 'fixture server reloaded again during the case')
      assert(retry.errors.length === 0, `page errors: ${retry.errors.join(', ')}`)
    }
  }

  return { browser, results, warmPage, open, check, assert, scene }
}
