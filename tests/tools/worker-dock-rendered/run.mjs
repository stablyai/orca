// Rendered interaction checks for the worker pill and card, in headless Chromium with real layout.
// Start the fixture server (`pnpm dev:fixtures -- --port 5600 --strictPort`), then run
// `node tests/tools/worker-dock-rendered/run.mjs [baseUrl] [shotDir]`. Exits non-zero on a failure.
import {
  card,
  createFixtureSession,
  events,
  expanded,
  focusedRow,
  region,
  rows,
  scrollState,
  toggle
} from './fixture-session.mjs'
import { runLoadingAndLayerChecks } from './loading-and-layer-checks.mjs'
import { runChipNameChecks } from './chip-name-checks.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:5600'
const shots = process.argv[3]
const filter = process.env.ORCA_WORKER_DOCK_TEST_FILTER
const FIXTURE = 'native-chat/tools/tasks/dock/WorkerDockHarness'

const { browser, results, warmPage, open, check, assert, scene } = await createFixtureSession({
  base,
  filter,
  fixture: FIXTURE
})

// Stop and Clear take presses only once their row is hovered, as a pointer always passes over it.
const rowOfAction = (action) => action.locator('xpath=ancestor::*[@data-worker-dock-row][1]')
const shot = async (page, name) => {
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, `${name}.png`) })
  }
}

try {
  await warmPage(filter === 'opens by touch tap' || filter === 'scrolls by touch drag')
} catch (error) {
  await browser.close()
  throw error
}

await check('opens and folds from the pill by click, Enter and Space', () =>
  scene('twentyFolded720', {}, async (page) => {
    assert((await card(page).count()) === 0, 'card drawn while folded')
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
      const before = await expanded(page)
      await press()
      await page.waitForTimeout(150)
      assert(before !== (await expanded(page)), `pill stayed ${before}`)
      assert((await card(page).count()) === Number(!before), 'card did not follow the pill')
    }
  })
)

await check('Escape folds the card and returns focus to the pill', () =>
  scene('twentyOpen720', {}, async (page) => {
    await page.locator('[data-worker-dock-open]').nth(2).focus()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    assert(!(await expanded(page)), 'Escape did not fold')
    const onPill = await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-worker-dock-pill')
    )
    assert(onPill, 'focus did not return to the pill')
  })
)

await check('a press outside the pill and card folds it; one inside does not', () =>
  scene('twentyOpen720', {}, async (page) => {
    const box = await card(page).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + 2)
    await page.waitForTimeout(150)
    assert(await expanded(page), 'a press on the card folded it')
    await page.mouse.click(20, 40)
    await page.waitForTimeout(150)
    assert(!(await expanded(page)), 'a press on the transcript did not fold it')
  })
)

await check('opens by touch tap', () =>
  scene('twentyFolded720', { touch: true }, async (page) => {
    await toggle(page).tap()
    await page.waitForTimeout(150)
    assert(await expanded(page), 'tap did not open')
  })
)

await check('opens and folds after a held gesture that ended outside the card', () =>
  scene('twentyOpen720', {}, async (page) => {
    const box = await page.locator('[data-worker-dock-row]').nth(4).boundingBox()
    await page.mouse.move(box.x + 20, box.y + 10)
    await page.mouse.down()
    await page.evaluate(() => window.__workerDockHarness.start('Started mid-gesture'))
    await page.mouse.move(box.x + 20, box.y + 12)
    await page.mouse.up()
    await page.waitForTimeout(150)
    await toggle(page).click()
    await page.waitForTimeout(150)
    assert(!(await expanded(page)), 'did not fold')
    await toggle(page).click()
    await page.waitForTimeout(150)
    assert(await expanded(page), 'did not reopen')
  })
)

await runChipNameChecks({ check, scene, assert })

await check('a worker waiting on you leads the pill and the card, then failed, running, done', () =>
  scene('askOpen720', {}, async (page) => {
    const order = (await rows(page)).map((row) => row.state)
    assert(order[0] === 'needs-you', `first row is ${order[0]}`)
    const rank = (state) =>
      ({ 'needs-you': 0, failed: 1, running: 2, coordinator: 3, idle: 4 })[state] ?? 9
    assert(
      order.every((state, index) => index === 0 || rank(order[index - 1]) <= rank(state)),
      `order ${order.join(', ')}`
    )
    const text = await region(page).textContent()
    for (const banned of ['Status unavailable', 'Open work', 'Status changed']) {
      assert(!text.includes(banned), `card shows "${banned}"`)
    }
    await shot(page, 'ask-open')
    await toggle(page).click()
    const title = await toggle(page).getAttribute('aria-label')
    assert(title.includes('latest: Approve: run the migration'), `pill says "${title}"`)
  })
)

await check('updates the pill count live as workers start and finish', () =>
  scene('fourOpen720', {}, async (page) => {
    const name = async () =>
      ((await toggle(page).textContent()) ?? '').replace(/^Workers\s*(\d+)$/, '$1 workers')
    await page.evaluate(() => window.__workerDockHarness.start('Fresh worker'))
    await page.waitForTimeout(150)
    assert((await name()).startsWith('5 workers'), `after start: ${await name()}`)
    await page.evaluate(() => window.__workerDockHarness.finish('dock:3'))
    await page.waitForTimeout(150)
    assert((await name()).startsWith('4 workers'), `after finish: ${await name()}`)
    assert((await rows(page)).length === 4, 'row list did not follow')
  })
)

for (const [width, sceneName] of [
  [760, 'twentyOpen720'],
  [430, 'twentyOpen390'],
  [360, 'twentyOpen320'],
  [340, 'longOpen300']
]) {
  for (const height of [560, 1000]) {
    await check(
      `shows six rows, scrolls the rest and stays in the pane (${sceneName}, ${height}px tall)`,
      () =>
        scene(sceneName, { width, height }, async (page) => {
          const first = await scrollState(page)
          assert(first.client <= 6 * 40 + 1, `list is ${first.client}px, more than six rows`)
          assert(first.height > first.client, `nothing to scroll: ${JSON.stringify(first)}`)
          const box = await region(page).boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          for (let step = 0; step < 5; step++) {
            await page.mouse.wheel(0, 12)
            await page.waitForTimeout(250)
          }
          assert((await scrollState(page)).top >= 50, 'five 12px ticks did not move the list')
          await page.mouse.wheel(0, 20_000)
          await page.waitForTimeout(250)
          const lastBox = await page.locator('[data-worker-dock-row]').last().boundingBox()
          const regionBox = await region(page).boundingBox()
          assert(
            lastBox.y + lastBox.height <= regionBox.y + regionBox.height + 1,
            'last row clipped'
          )
          const [cardBox, pillBox, composer] = await Promise.all([
            card(page).boundingBox(),
            toggle(page).boundingBox(),
            page.locator('[data-fixture-composer]').boundingBox()
          ])
          // The header is the chip, opened in place: on top of the panel, which ends 8px above the message box.
          assert(Math.abs(pillBox.y - cardBox.y - 5) <= 1, 'the header is not the panel top')
          assert(cardBox.y >= 0, 'card runs off the top of the pane')
          const gap = composer.y - (cardBox.y + cardBox.height)
          assert(gap >= 8, `panel sits ${gap}px above the message box`)
          const field = await page.locator('[data-fixture-composer]').locator('..').boundingBox()
          assert(
            Math.abs(cardBox.x - field.x) <= 1 && Math.abs(cardBox.width - field.width) <= 1,
            `panel is ${cardBox.width}px wide, message box ${field.width}px`
          )
          await shot(page, `bottom-${sceneName}-${height}`)
        })
    )
  }
}

await check(
  'Up and Down move between rows, End reaches the last, Up past the first lands on the header',
  () =>
    scene('twentyOpen720', {}, async (page) => {
      await toggle(page).focus()
      await page.keyboard.press('ArrowDown')
      const ids = (await rows(page)).map((row) => row.id)
      assert((await focusedRow(page)) === ids[0], 'Down from the pill did not reach the first row')
      await page.keyboard.press('ArrowDown')
      assert((await focusedRow(page)) === ids[1], 'Down did not move to the next row')
      await page.keyboard.press('ArrowUp')
      assert((await focusedRow(page)) === ids[0], 'Up did not move back')
      await page.keyboard.press('End')
      await page.waitForTimeout(100)
      assert((await focusedRow(page)) === ids.at(-1), 'End did not reach the last row')
      const end = await scrollState(page)
      assert(end.top + end.client >= end.height - 1, 'the last row is not scrolled into view')
      await page.keyboard.press('ArrowDown')
      assert((await focusedRow(page)) === ids.at(-1), 'Down past the last row left it')
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowUp')
      const onPill = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-worker-dock-pill')
      )
      assert(onPill, 'Up past the first row did not land on the header')
    })
)

await check('Enter on a focused row opens the worker', () =>
  scene('fourOpen720', {}, async (page) => {
    await page.locator('[data-worker-dock-row="dock:2"] [data-worker-dock-open]').focus()
    await page.keyboard.press('Enter')
    const sent = await events(page)
    assert(
      sent.some((event) => event.action === 'open' && event.id === 'dock:2'),
      'no open'
    )
  })
)

await check('Tab walks into the rows and keeps the focused row in view', () =>
  scene('twentyOpen720', {}, async (page) => {
    await page.locator('[data-worker-dock-open]').first().focus()
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press('Tab')
    }
    const inView = await page.evaluate(() => {
      const focused = document.activeElement
      const list = document.querySelector('[data-worker-dock-card] [role="region"]')
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

await check('hover shows Stop over the row end; it does not show at rest', () =>
  scene('fourOpen720', {}, async (page) => {
    const row = page.locator('[data-worker-dock-row="dock:2"]')
    const shown = () =>
      row.evaluate(
        (element) => getComputedStyle(element.querySelector('[data-worker-dock-hover]')).opacity
      )
    await page.mouse.move(1, 1)
    assert((await shown()) === '0', `at rest: ${await shown()}`)
    // At rest a press where Stop will appear opens the row instead.
    const hit = await row.evaluate((element) => {
      const action = element.querySelector('[data-worker-dock-action]').getBoundingClientRect()
      return document
        .elementFromPoint(action.x + action.width / 2, action.y + action.height / 2)
        ?.closest('[data-worker-dock-open],[data-worker-dock-action]')
        ?.hasAttribute('data-worker-dock-open')
    })
    assert(hit, 'an invisible Stop takes presses at rest')
    await row.hover()
    await page.waitForTimeout(100)
    assert((await shown()) === '1', `on hover: ${await shown()}`)
    const [rowBox, fillTarget] = await Promise.all([row.boundingBox(), region(page).boundingBox()])
    assert(Math.abs(rowBox.width - fillTarget.width) <= 1, 'hover fill stops short of the card')
    await shot(page, 'row-hover')
  })
)

await check('the open panel replaces the chip, spans the message box, and titles are not cut', () =>
  scene('threeOpen720', {}, async (page) => {
    const [box, composer] = await Promise.all([
      card(page).boundingBox(),
      page.locator('[data-fixture-composer]').locator('..').boundingBox()
    ])
    assert(Math.abs(box.width - composer.width) <= 1, `panel is ${box.width}px wide`)
    assert((await page.locator('[data-worker-dock-pill]').count()) === 1, 'a second pill shows')
    const header = await toggle(page).boundingBox()
    assert(header.y >= box.y && header.y + header.height <= box.y + 40, 'header is not on top')
    await page.mouse.move(1, 1)
    // Every title shows whole: none is clamped short of its own height or narrower than its row.
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll('[data-worker-dock-open] .line-clamp-3')].some((title) => {
        const row = title.closest('[data-worker-dock-row]').getBoundingClientRect()
        return (
          title.scrollHeight > title.clientHeight + 1 ||
          title.getBoundingClientRect().width < row.width / 2
        )
      })
    )
    assert(!cut, 'a title is cut')
  })
)

await check('the list fades where rows are out of view', () =>
  scene('twentyOpen720', {}, async (page) => {
    const mask = () => region(page).evaluate((element) => getComputedStyle(element).maskImage)
    // Computed colors read transparent back as rgba(0, 0, 0, 0).
    const clear = (value) => (value.match(/rgba\(0, 0, 0, 0\)|transparent/g) ?? []).length
    const first = await mask()
    assert(first.includes('gradient') && clear(first) === 1, `at the top: ${first}`)
    await region(page).evaluate((element) => {
      element.scrollTop = 60
      element.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(100)
    const middle = await mask()
    assert(clear(middle) === 2, `mid-list: ${middle}`)
    await open('threeOpen720', {})
    assert((await mask()) === 'none', 'a list that fits is faded')
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
    await rowOfAction(x).hover()
    await x.click()
    await page.waitForTimeout(300)
    const after = await rows(page)
    assert(after.length === before.length - 1, `rows ${before.length} -> ${after.length}`)
    assert(!after.some((row) => row.id === target), 'cleared row still drawn')
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

await check('Clear failed in the footer clears every failure', () =>
  scene('twentyOpen720', {}, async (page) => {
    await page.getByRole('button', { name: /Clear all/ }).click()
    await page.waitForTimeout(300)
    const after = await rows(page)
    assert(!after.some((row) => row.state === 'failed'), 'a failure is still shown')
    assert(after.length === 17, `expected 17 rows, saw ${after.length}`)
  })
)

await check('Stop all shows in the panel header only when it applies, and stops', () =>
  scene('stopAllOpen720', {}, async (page) => {
    const stop = page.getByRole('button', { name: 'Stop all' })
    const [box, header] = await Promise.all([stop.boundingBox(), toggle(page).boundingBox()])
    assert(Math.abs(box.y + box.height / 2 - (header.y + header.height / 2)) <= 1, 'not in header')
    await stop.click()
    assert(
      (await events(page)).some((event) => event.action === 'stop-all'),
      'no Stop all'
    )
    await shot(page, 'header-stop-all')
    await open('fourOpen720', {})
    assert((await page.getByRole('button', { name: 'Stop all' }).count()) === 0, 'Stop all drawn')
    assert((await page.locator('[data-worker-dock-footer]').count()) === 0, 'empty footer drawn')
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

await check('a row click opens the worker', () =>
  scene('fourOpen720', {}, async (page) => {
    const row = await page.locator('[data-worker-dock-row="dock:2"]').boundingBox()
    // The arrow end of the row opens it too, not only the title.
    await page.mouse.click(row.x + row.width - 6, row.y + row.height / 2)
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
    await rowOfAction(button).hover()
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

await check('clearing a failure acknowledges it without showing a toast', () =>
  scene('twentyOpen720', {}, async (page) => {
    const row = page.locator('[data-worker-dock-row="dock:0"]')
    await row.hover()
    await row.locator('[data-worker-dock-action]').click()
    await row.waitFor({ state: 'detached' })
    await page.waitForTimeout(200)
    assert(
      (await events(page)).some(
        (event) => event.action === 'clear' && event.id === 'ctx_fixture_0'
      ),
      'clear was not acknowledged for the row'
    )
    assert(
      (await page.getByRole('button', { name: 'Show in dock again' }).count()) === 0,
      'cleared toast action was shown'
    )
    assert((await page.locator('[data-sonner-toast]').count()) === 0, 'cleared toast was shown')
    assert(await expanded(page), 'clearing folded the card')
  })
)

await runLoadingAndLayerChecks({ check, scene, assert, shot })

await check('Jump to latest rests in the transcript, clear above the chip row', () =>
  scene('jumpFolded720', {}, async (page) => {
    const jump = page.getByRole('button', { name: 'Jump to latest' })
    await jump.waitFor()
    const [a, b] = await Promise.all([jump.boundingBox(), toggle(page).boundingBox()])
    const gap = b.y - (a.y + a.height)
    // Jump keeps its 12px rest in the transcript; the chip's row starts 8px below that.
    assert(Math.abs(gap - 20) <= 1, `Jump to latest sits ${gap}px above the pill`)
    const transcript = await page.locator('[data-fixture-transcript]').boundingBox()
    assert(b.y >= transcript.y + transcript.height, 'the chip is drawn over the transcript')
    await shot(page, 'jump-stacked')
  })
)

await check('at the end of the chat the last line clears the pill', () =>
  scene('threeFolded720', {}, async (page) => {
    await page.waitForTimeout(150)
    const [line, pill] = await Promise.all([
      page.locator('[data-fixture-last-line]').boundingBox(),
      toggle(page).boundingBox()
    ])
    assert(
      line.y + line.height <= pill.y,
      `last line ends at ${line.y + line.height}, pill at ${pill.y}`
    )
    const behind = await page.evaluate(() => {
      const pill = document.querySelector('[data-worker-dock-pill]').getBoundingClientRect()
      const hit = document.elementFromPoint(pill.left - 6, pill.top + pill.height / 2)
      return hit?.closest('[data-worker-dock-float]') ? 'band' : 'ok'
    })
    assert(behind === 'ok', 'something is drawn beside the pill')
  })
)

await check('a narrow pane keeps the chip to its count, inside the pane', () =>
  scene('longFolded300', { width: 340 }, async (page) => {
    const title = await page.locator('[data-worker-dock-pill-title]').textContent()
    assert(/^\d+ workers?$/.test(title ?? ''), `chip shows "${title}"`)
    const box = await toggle(page).boundingBox()
    assert(box.x >= 0 && box.x + box.width <= 340, 'pill leaves the pane')
    await shot(page, 'narrow-300')
  })
)

for (const width of [720, 390, 320]) {
  for (const theme of ['light', 'dark']) {
    for (const layer of ['question', 'queue', 'both']) {
      await check(`sits at the start just above the ${layer} (${width}px, ${theme})`, () =>
        scene(`${layer}${width}`, { width: width + 40, height: 900, theme }, async (page) => {
          const sibling =
            layer === 'queue'
              ? page.locator('[data-native-chat-queue] .rounded-lg').first()
              : page.locator('[data-native-chat-question-card] [data-native-chat-dock-clip]')
          const [a, b] = await Promise.all([toggle(page).boundingBox(), sibling.boundingBox()])
          assert(a && b, 'pill or next card missing')
          const gap = b.y - a.y - a.height
          assert(Math.abs(gap - 8) <= 1, `gap is ${gap}px`)
          assert(Math.abs(a.x - b.x) <= 1, 'pill does not start with the next card')
          assert(
            (await page.getByRole('button', { name: /Clear all/ }).count()) === 0,
            'folded Clear all is visible'
          )
          await shot(page, `${layer}-${width}-${theme}`)
          await toggle(page).click()
          await page.getByRole('button', { name: /Clear all/ }).waitFor()
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
      await rowOfAction(x).hover()
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
      [760, 'oneFolded720'],
      [760, 'threeFolded720'],
      [760, 'threeOpen720'],
      [760, 'twentyFolded720'],
      [760, 'twentyOpen720'],
      [760, 'askFolded720'],
      [760, 'askOpen720'],
      [760, 'jumpFolded720'],
      [340, 'longFolded300'],
      [340, 'longOpen300']
    ]) {
      const opened = await open(sceneName, { width, height: 900, theme })
      await opened.page.waitForTimeout(300)
      await opened.page.screenshot({ path: path.join(shots, `${sceneName}-${theme}.png`) })
    }
  }
}

await browser.close()
const failed = results.filter((result) => !result.ok).length
console.log(`${results.length - failed} passed, ${failed} failed`)
if (!results.length) {
  console.error(`No check matches ORCA_WORKER_DOCK_TEST_FILTER=${filter}`)
}
process.exitCode = failed || !results.length ? 1 : 0
