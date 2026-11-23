// Rendered interaction checks for the workers strip, in headless Chromium with real layout.
// Start the fixture server (`pnpm dev:fixtures -- --port 5600 --strictPort`), then run
// `node tests/tools/worker-dock-rendered/run.mjs [baseUrl] [shotDir]`. Exits non-zero on a failure.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:5600'
const shots = process.argv[3]
const filter = process.env.ORCA_WORKER_DOCK_TEST_FILTER
const FIXTURE = 'native-chat/tools/tasks/dock/WorkerDockHarness'
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
    await opened.page.waitForFunction(() => Boolean(window.__orcaComponentFixtureHost), undefined, {
      timeout: 60_000
    })
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

const toggle = (page) => page.locator('[data-worker-dock-header] button[aria-expanded]')
const region = (page) => page.locator('[data-native-chat-background-tasks] [role="region"]')
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-worker-dock-row]')].map((row) => ({
      id: row.getAttribute('data-worker-dock-row'),
      state: row.querySelector('[data-worker-dock-state]')?.textContent ?? ''
    }))
  )
const scrollState = (page) =>
  region(page).evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight
  }))
const events = (page) => page.evaluate(() => window.__workerDockHarness?.events ?? [])

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

try {
  await warmPage(filter === 'opens by touch tap' || filter === 'scrolls by touch drag')
} catch (error) {
  await browser.close()
  throw error
}

await check('opens and folds from the header by click, Enter and Space', () =>
  scene('twentyFolded720', {}, async (page) => {
    for (const press of [
      () => toggle(page).click(),
      () => toggle(page).click(),
      async () => {
        await toggle(page).focus()
        await page.keyboard.press('Enter')
      },
      async () => {
        await toggle(page).focus()
        await page.keyboard.press('Space')
      }
    ]) {
      const before = await toggle(page).getAttribute('aria-expanded')
      await press()
      await page.waitForTimeout(150)
      const after = await toggle(page).getAttribute('aria-expanded')
      assert(before !== after, `toggle stayed ${after}`)
    }
  })
)

await check('opens by touch tap', () =>
  scene('twentyFolded720', { touch: true }, async (page) => {
    await toggle(page).tap()
    await page.waitForTimeout(150)
    assert((await toggle(page).getAttribute('aria-expanded')) === 'true', 'tap did not open')
  })
)

await check('opens and folds after a held gesture that ended outside the strip', () =>
  scene('twentyOpen720', {}, async (page) => {
    const box = await page.locator('[data-worker-dock-row]').nth(4).boundingBox()
    await page.mouse.move(box.x + 20, box.y + 10)
    await page.mouse.down()
    await page.evaluate(() => window.__workerDockHarness.start('Started mid-gesture'))
    await page.mouse.move(5, 5)
    await page.mouse.up()
    await page.waitForTimeout(150)
    await toggle(page).click()
    await page.waitForTimeout(150)
    assert((await toggle(page).getAttribute('aria-expanded')) === 'false', 'did not fold')
    await toggle(page).click()
    await page.waitForTimeout(150)
    assert((await toggle(page).getAttribute('aria-expanded')) === 'true', 'did not reopen')
  })
)

for (const [count, label] of [
  ['oneOpen720', /^1 worker\b/],
  ['fourOpen720', /^4 workers · 1 failed/],
  ['twentyOpen720', /^20 workers · 3 failed/]
]) {
  await check(`keeps the count in the open header (${count})`, () =>
    scene(count, {}, async (page) => {
      assert((await toggle(page).getAttribute('aria-expanded')) === 'true', 'not open')
      const text = (await toggle(page).textContent()).replaceAll(' ', ' ')
      assert(label.test(text), `header says "${text}"`)
      assert(await toggle(page).isVisible(), 'header hidden')
    })
  )
}

await check('updates the open header count live as workers start and finish', () =>
  scene('fourOpen720', {}, async (page) => {
    const text = async () => (await toggle(page).textContent()).replaceAll(' ', ' ')
    await page.evaluate(() => window.__workerDockHarness.start('Fresh worker'))
    await page.waitForTimeout(150)
    assert((await text()).startsWith('5 workers'), `after start: ${await text()}`)
    await page.evaluate(() => window.__workerDockHarness.finish('dock:3'))
    await page.waitForTimeout(150)
    assert((await text()).startsWith('4 workers'), `after finish: ${await text()}`)
    assert((await rows(page)).length === 4, 'row list did not follow')
  })
)

for (const [width, sceneName] of [
  [760, 'twentyOpen720'],
  [430, 'twentyOpen390'],
  [360, 'twentyOpen320']
]) {
  for (const height of [560, 1000]) {
    await check(
      `scrolls by wheel in small steps and reaches the last row (${sceneName}, ${height}px tall)`,
      () =>
        scene(sceneName, { width, height }, async (page) => {
          const first = await scrollState(page)
          assert(first.height > first.client, `nothing to scroll: ${JSON.stringify(first)}`)
          const box = await region(page).boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          for (let step = 0; step < 5; step++) {
            await page.mouse.wheel(0, 12)
            await page.waitForTimeout(250)
          }
          const moved = await scrollState(page)
          assert(moved.top >= 50, `five 12px ticks moved ${moved.top}px`)
          await page.mouse.wheel(0, 20_000)
          await page.waitForTimeout(250)
          const last = page.locator('[data-worker-dock-row]').last()
          const lastBox = await last.boundingBox()
          const regionBox = await region(page).boundingBox()
          assert(
            lastBox.y + lastBox.height <= regionBox.y + regionBox.height + 1,
            'last row clipped at the bottom'
          )
          const header = await toggle(page).boundingBox()
          assert(header.y >= 0, 'header scrolled away')
          const composer = await page.locator('[data-fixture-composer]').boundingBox()
          assert(regionBox.y + regionBox.height <= composer.y + 1, 'list overlaps the message box')
          assert(composer.y + composer.height <= height, 'message box pushed off screen')
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await page.screenshot({ path: path.join(shots, `bottom-${width}x${height}.png`) })
          }
        })
    )
  }
}

await check('scrolls by keyboard: arrows, Page Down and End', () =>
  scene('twentyOpen720', {}, async (page) => {
    await region(page).focus()
    await page.keyboard.press('ArrowDown')
    const arrow = (await scrollState(page)).top
    assert(arrow > 0, 'ArrowDown did not move')
    await page.keyboard.press('PageDown')
    const paged = (await scrollState(page)).top
    assert(paged > arrow, 'PageDown did not move')
    await page.keyboard.press('End')
    await page.waitForTimeout(100)
    const end = await scrollState(page)
    assert(end.top + end.client >= end.height - 1, 'End did not reach the bottom')
  })
)

await check('Tab walks into the rows and keeps the focused row in view', () =>
  scene('twentyOpen720', {}, async (page) => {
    await toggle(page).focus()
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press('Tab')
    }
    const inView = await page.evaluate(() => {
      const focused = document.activeElement
      const list = document.querySelector('[data-native-chat-background-tasks] [role="region"]')
      if (!focused || !list?.contains(focused)) {
        return 'focus left the list'
      }
      const a = focused.getBoundingClientRect()
      const b = list.getBoundingClientRect()
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 ? 'ok' : 'focused row out of view'
    })
    assert(inView === 'ok', inView)
  })
)

await check('scrolls by touch drag', () =>
  scene('twentyOpen720', { touch: true }, async (page) => {
    const box = await region(page).boundingBox()
    const client = await page.context().newCDPSession(page)
    const x = box.x + box.width / 2
    const from = box.y + box.height - 10
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: from }]
    })
    for (let step = 1; step <= 10; step++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: from - step * 12 }]
      })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(400)
    assert((await scrollState(page)).top > 40, 'touch drag did not scroll')
  })
)

await check('X clears a failed row at once, even while hovered and focused', () =>
  scene('twentyOpen720', {}, async (page) => {
    const before = await rows(page)
    const x = page.locator('[data-worker-dock-action]').first()
    const target = await x.getAttribute('data-worker-dock-action')
    await x.click()
    await page.waitForTimeout(300)
    const after = await rows(page)
    assert(after.length === before.length - 1, `rows ${before.length} -> ${after.length}`)
    assert(!after.some((row) => row.id === target), 'cleared row still drawn')
    assert(!after.some((row) => /Done/.test(row.state)), 'ghost "Done" row left behind')
    const held = await page.getByText('Order held').count()
    assert(held === 0, '"Order held" shown after a Clear')
    const focus = await page.evaluate(() => document.activeElement?.tagName ?? 'none')
    assert(focus !== 'BODY', 'focus dropped to the page')
  })
)

await check('X clears by keyboard (Enter)', () =>
  scene('twentyOpen720', {}, async (page) => {
    const x = page.locator('[data-worker-dock-action]').first()
    const target = await x.getAttribute('data-worker-dock-action')
    await x.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    assert(!(await rows(page)).some((row) => row.id === target), 'Enter did not clear')
  })
)

await check('Clear all clears every failure', () =>
  scene('twentyOpen720', {}, async (page) => {
    await page.getByRole('button', { name: /Clear all/ }).click()
    await page.waitForTimeout(300)
    const after = await rows(page)
    assert(!after.some((row) => row.state === 'Failed'), 'a failure is still shown')
    assert(after.length === 17, `expected 17 rows, saw ${after.length}`)
  })
)

await check('Stop on a running row sends Stop and the row leaves', () =>
  scene('fourOpen720', {}, async (page) => {
    const row = page.locator('[data-worker-dock-row="dock:2"]')
    await row.hover()
    await row.locator('[data-worker-dock-action]').click()
    await page.waitForTimeout(300)
    const sent = await events(page)
    assert(
      sent.some((event) => event.action === 'stop' && event.id === 'dock:2'),
      'no Stop sent'
    )
    assert(!(await rows(page)).some((item) => item.id === 'dock:2'), 'stopped row still drawn')
  })
)

await check('Show opens the worker', () =>
  scene('fourOpen720', {}, async (page) => {
    await page.locator('[data-worker-dock-row="dock:2"] [data-worker-dock-open]').click()
    const sent = await events(page)
    assert(
      sent.some((event) => event.action === 'open' && event.id === 'dock:2'),
      'no open sent'
    )
  })
)

await check('a remote chat shows no Stop or Clear that would do nothing', () =>
  scene('remoteOpen720', {}, async (page) => {
    assert((await rows(page)).length === 6, 'rows missing')
    const actions = await page.locator('[data-worker-dock-action]').count()
    assert(actions === 0, `${actions} live-looking actions on a remote chat`)
    assert((await page.getByRole('button', { name: /Clear all/ }).count()) === 0, 'Clear all shown')
  })
)

await check('a paired chat command still stops', () =>
  scene('remoteCommand720', {}, async (page) => {
    const button = page.getByRole('button', { name: /Stop Command · Check the build/ })
    await button.click()
    assert(
      (await events(page)).some(
        (event) => event.action === 'remote-stop' && event.id === 'shell-fixture'
      ),
      'Stop was not routed to the chat'
    )
    await button.waitFor({ state: 'detached' })
  })
)

await check('Show in dock again restores the acknowledged failure', () =>
  scene('twentyOpen720', {}, async (page) => {
    const row = page.locator('[data-worker-dock-row="dock:0"]')
    await row.locator('[data-worker-dock-action]').click()
    await row.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Show in dock again' }).click()
    await row.waitFor()
    assert(
      (await events(page)).some(
        (event) => event.action === 'restore' && event.id === 'ctx_fixture_0'
      ),
      'wrong settlement restored'
    )
  })
)

for (const width of [720, 390, 320]) {
  for (const theme of ['light', 'dark']) {
    for (const layer of ['question', 'queue', 'both']) {
      await check(`aligns with ${layer} (${width}px, ${theme})`, () =>
        scene(`${layer}${width}`, { width: width + 40, height: 900, theme }, async (page) => {
          const strip = page.locator('[data-native-chat-background-tasks]')
          const header = toggle(page)
          const sibling =
            layer === 'queue'
              ? page.locator('[data-native-chat-queue] .rounded-lg').first()
              : page.locator('[data-native-chat-question-card] [data-native-chat-dock-clip]')
          const assertPlacement = async () => {
            const [a, b] = await Promise.all([strip.boundingBox(), sibling.boundingBox()])
            assert(a && b, 'strip or next card missing')
            const gap = b.y - a.y - a.height
            assert(gap >= 8 && gap <= 10, `gap is ${gap}px`)
            assert(
              Math.abs(a.x - b.x) <= 1 && Math.abs(a.width - b.width) <= 1,
              'edges do not align'
            )
          }
          assert(
            (await header.textContent()).trim() === '9 workers · 2 failed',
            'folded summary includes extra counts'
          )
          assert(
            (await page.getByRole('button', { name: /Clear all/ }).count()) === 0,
            'folded Clear all is visible'
          )
          await assertPlacement()
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await page.screenshot({ path: path.join(shots, `${layer}-${width}-${theme}.png`) })
          }
          await header.click()
          await page.getByRole('button', { name: /Clear all/ }).waitFor()
          await assertPlacement()
        })
      )
    }
  }
}

for (const [width, sceneName] of [
  [430, 'twentyOpen390'],
  [360, 'twentyOpen320']
]) {
  await check(`narrow ${sceneName}: X sits inside the list and clears`, () =>
    scene(sceneName, { width, height: 800 }, async (page) => {
      const x = page.locator('[data-worker-dock-action]').first()
      const box = await x.boundingBox()
      const list = await region(page).boundingBox()
      assert(box.x >= list.x && box.x + box.width <= list.x + list.width + 1, 'X outside the list')
      const target = await x.getAttribute('data-worker-dock-action')
      await x.click()
      await page.waitForTimeout(300)
      assert(!(await rows(page)).some((row) => row.id === target), 'narrow X did not clear')
    })
  )
}

for (const chat of ['coordinator', 'bot']) {
  await check(`keeps the report without a Finished row in a ${chat} chat`, () =>
    scene(chat, { fixture: 'native-chat/tools/tasks/dock/WorkerDockCompletion' }, async (page) => {
      await page.getByRole('button', { name: /1 worker/ }).waitFor()
      await page.getByRole('button', { name: 'Complete fixture worker' }).click()
      await page.getByText('The worker verified the release notes.', { exact: true }).waitFor()
      await page.getByRole('button', { name: /1 worker/ }).waitFor({ state: 'detached' })
      assert(
        (await page.locator('[data-native-chat-worker-result]').count()) === 0,
        'the transcript duplicated the report with a Finished row'
      )
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: path.join(shots, `completion-${chat}.png`) })
      }
    })
  )
}

if (shots && !filter) {
  for (const theme of ['light', 'dark']) {
    for (const [width, sceneName] of [
      [760, 'twentyOpen720'],
      [430, 'twentyOpen390'],
      [360, 'twentyOpen320']
    ]) {
      const opened = await open(sceneName, { width, height: 900, theme })
      await region(opened.page).evaluate((element) => {
        element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2)
      })
      await opened.page.waitForTimeout(200)
      await opened.page.screenshot({ path: path.join(shots, `mid-${sceneName}-${theme}.png`) })
      await region(opened.page).evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await opened.page.waitForTimeout(200)
      await opened.page.screenshot({ path: path.join(shots, `end-${sceneName}-${theme}.png`) })
    }
  }
}

await browser.close()
const failed = results.filter((result) => !result.ok).length
console.log(`${results.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
