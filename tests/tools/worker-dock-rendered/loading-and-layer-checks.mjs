// Checks for rows whose details load late, monitoring with no listed rows, dialogs a row opens,
// and Jump to latest over the open card. Imported by run.mjs.
import { card, chip, events, expanded, focusedRow, rows, toggle } from './fixture-session.mjs'

const rowOf = (id) => `[data-worker-dock-row="${id}"]`
const focusedIs = (page, id) =>
  page.waitForFunction(
    (target) =>
      document.activeElement
        ?.closest('[data-worker-dock-row]')
        ?.getAttribute('data-worker-dock-row') === target,
    id
  )
const loaded = (page, id) =>
  page.waitForFunction((selector) => {
    const state = document.querySelector(selector)?.getAttribute('data-worker-dock-state')
    return state && state !== 'loading'
  }, rowOf(id))

export async function runLoadingAndLayerChecks({ check, scene, assert, shot }) {
  await check('the folded chip hugs its label', () =>
    scene('threeFolded720', {}, async (page) => {
      const width = await toggle(page).evaluate((chip) => {
        const label = chip.querySelector('[data-worker-dock-pill-title]')
        return chip.getBoundingClientRect().width - label.getBoundingClientRect().width
      })
      // Glyph, gap, padding and border only.
      assert(width <= 44, `the chip is ${width}px wider than its label`)
    })
  )

  await check(
    'a pane so short the dock takes the transcript floor: the chip clears the dock, the open card stays in the pane',
    () =>
      scene('both320', { width: 360, height: 260 }, async (page) => {
        const fit = await page
          .locator('[data-native-chat-root]')
          .evaluate((root) => root.getAttribute('data-native-chat-dock-fit') ?? '')
        assert(
          fit.split(' ').includes('transcript'),
          `dock fit "${fit}" never gave up the transcript`
        )
        const clear = async (when) => {
          const [chipBox, dock] = await Promise.all([
            card(page)
              .count()
              .then((open) => (open ? card(page) : chip(page)).boundingBox()),
            page.locator('[data-native-chat-dock]').boundingBox()
          ])
          assert(chipBox.y + chipBox.height <= dock.y + 1, `${when}: the chip runs over the dock`)
          // A press on the question card reaches the card, not the chip's frame.
          const hit = await page.evaluate(() => {
            const question = document.querySelector('[data-native-chat-question-card]')
            const box = question.getBoundingClientRect()
            const target = document.elementFromPoint(box.left + box.width / 2, box.top + 8)
            return Boolean(target?.closest('[data-native-chat-question-card]'))
          })
          assert(hit, `${when}: a press on the question card lands on the chip`)
        }
        await clear('folded')
        await toggle(page).click()
        await page.waitForTimeout(400)
        // No room above for a header and a row: it drops over the dock, whole, like a popover.
        const [open, pane] = await Promise.all([
          card(page).boundingBox(),
          page.locator('[data-native-chat-root]').boundingBox()
        ])
        assert(open.y >= pane.y, `the open card starts ${pane.y - open.y}px above the pane`)
        assert(open.y + open.height <= pane.y + pane.height, 'the open card runs off the pane')
        // Folding, it slides back with the shape: no frame starts above the pane.
        const highest = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const pane = document.querySelector('[data-native-chat-root]').getBoundingClientRect()
              const shape = document.querySelector('[data-worker-dock-morph]')
              let worst = Infinity
              document.querySelector('[data-worker-dock-pill]').click()
              const start = performance.now()
              const step = () => {
                worst = Math.min(worst, shape.getBoundingClientRect().top - pane.top)
                if (performance.now() - start < 400) {
                  requestAnimationFrame(step)
                } else {
                  resolve(worst)
                }
              }
              step()
            })
        )
        assert(highest >= -1, `a folding frame starts ${-highest}px above the pane`)
      })
  )

  await check('a panel opened under a resting pointer keeps its row order as states change', () =>
    scene('twentyFolded720', {}, async (page) => {
      const box = await toggle(page).boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await card(page).waitFor()
      await page.waitForTimeout(150)
      const before = (await rows(page)).map((row) => row.id)
      await page.evaluate(() => window.__workerDockHarness.fail('Late failure'))
      await page.waitForTimeout(200)
      const after = (await rows(page)).map((row) => row.id)
      // A failure sorts before running rows; held, it joins the end instead.
      assert(
        before.every((id, index) => after[index] === id),
        `rows re-sorted under the pointer: ${before.slice(0, 5)} -> ${after.slice(0, 5)}`
      )
    })
  )

  await check('incomplete monitoring with no listed rows keeps the pill and Stop all', () =>
    scene('unlistedOpen720', {}, async (page) => {
      assert(!(await card(page).textContent()).includes('unavailable'), 'card says unavailable')
      await page.getByRole('button', { name: 'Stop all' }).click()
      assert(
        (await events(page)).some((event) => event.action === 'stop-all'),
        'no Stop all'
      )
      await toggle(page).click()
      const title = await toggle(page).textContent()
      assert(title === 'Background work running', `pill says "${title}"`)
    })
  )

  await check('End on 100 workers with late details focuses the last row and keeps it', () =>
    scene('lazyHundredOpen720', {}, async (page) => {
      await page.locator('[data-worker-dock-open]').first().focus()
      await page.keyboard.press('End')
      await page.waitForFunction(
        () =>
          document.activeElement
            ?.closest('[data-worker-dock-row]')
            ?.getAttribute('data-worker-dock-row') === 'dock:99'
      )
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-worker-dock-row="dock:99"]')
            ?.getAttribute('data-worker-dock-state') !== 'loading'
      )
      assert(
        (await focusedRow(page)) === 'dock:99',
        'focus left the last row when its details came'
      )
      await page.keyboard.press('Enter')
      const opened = (await events(page)).filter((event) => event.action === 'open')
      assert(opened.at(-1)?.id === 'dock:99', `Enter opened ${opened.at(-1)?.id}`)
      await page.keyboard.press('ArrowUp')
      await page.waitForFunction(
        () =>
          document.activeElement
            ?.closest('[data-worker-dock-row]')
            ?.getAttribute('data-worker-dock-row') === 'dock:98'
      )
    })
  )

  await check('rows the card puts first load on opening, and ArrowDown reaches them', () =>
    scene('reorderOpen720', {}, async (page) => {
      const ids = await page.evaluate(() =>
        [...document.querySelectorAll('[data-worker-dock-row]')]
          .slice(0, 2)
          .map((row) => row.getAttribute('data-worker-dock-row'))
      )
      assert(ids.join() === 'dock:49,dock:50', `card leads with ${ids.join()}`)
      await loaded(page, 'dock:50')
      await page.locator(`${rowOf('dock:49')} [data-worker-dock-open]`).focus()
      await page.keyboard.press('ArrowDown')
      await focusedIs(page, 'dock:50')
    })
  )

  await check('closing a row’s details dialog returns focus to that row in its own pane', () =>
    scene('twoPanesCommand720', { width: 760 }, async (page) => {
      const pane = page.locator('[data-fixture-pane="1"]')
      await pane.getByRole('button', { name: /^Command · Check the build/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      const box = await dialog.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + 12)
      assert(
        await expanded(page.locator('[data-fixture-pane="1"]')),
        'a press in the dialog folded the card'
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      // The dialog hands focus back a tick after it leaves.
      await page
        .waitForFunction(() => document.activeElement?.closest('[data-fixture-pane]'), undefined, {
          timeout: 1000
        })
        .catch(() => {})
      const where = await page.evaluate(() => {
        const active = document.activeElement
        return {
          pane: active?.closest('[data-fixture-pane]')?.getAttribute('data-fixture-pane'),
          row: active?.hasAttribute('data-worker-dock-open') ?? false
        }
      })
      assert(where.pane === '1' && where.row, `focus went to ${JSON.stringify(where)}`)
    })
  )

  await check(
    'over the open card, Jump to latest rides above it, stays reachable, and still jumps',
    () =>
      scene('jumpFolded720', {}, async (page) => {
        await toggle(page).click()
        await card(page).waitFor()
        // Jump goes straight to its place above the open card; the card reaches it after 280ms.
        await page.waitForTimeout(400)
        const jump = page.getByRole('button', { name: 'Jump to latest' })
        const [a, c] = await Promise.all([jump.boundingBox(), card(page).boundingBox()])
        const gap = c.y - (a.y + a.height)
        assert(Math.abs(gap - 8) <= 1, `Jump to latest sits ${gap}px above the open card`)
        const hit = await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? '',
          [a.x + a.width / 2, a.y + a.height / 2]
        )
        assert(hit.includes('Jump to latest'), `the point over Jump hits "${hit}"`)
        await toggle(page).click()
        await page.waitForTimeout(200)
        // The fold takes 280ms; Jump returns to its rest once the chip has shrunk back.
        await page.waitForTimeout(200)
        const [b, p] = await Promise.all([jump.boundingBox(), chip(page).boundingBox()])
        const rest = p.y - (b.y + b.height)
        assert(Math.abs(rest - 12) <= 1, `Jump settled ${rest}px above the chip, not 12px`)
        await jump.click()
        await page.waitForTimeout(200)
        const atEnd = await page.evaluate(() => {
          const element = document.querySelector('[data-fixture-transcript]')
          return element.scrollTop + element.clientHeight >= element.scrollHeight - 2
        })
        assert(atEnd, 'Jump to latest did not reach the end')
      })
  )

  await check('focus the user moves elsewhere during End is not taken back', () =>
    scene('lazyHundredOpen720', {}, async (page) => {
      await page.locator('[data-worker-dock-open]').first().focus()
      await page.keyboard.press('End')
      await page.locator('[data-fixture-composer]').focus()
      await page.waitForTimeout(800)
      const where = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-fixture-composer')
      )
      assert(where, 'a pending row focus took focus back from the message box')
    })
  )

  await check('after failed detail reads, End again loads the last row and Enter opens it', () =>
    scene('lazyFailingOpen720', {}, async (page) => {
      await page.locator('[data-worker-dock-open]').first().focus()
      await page.keyboard.press('End')
      await focusedIs(page, 'dock:99')
      await page.waitForTimeout(1200)
      await page.keyboard.press('End')
      await loaded(page, 'dock:99')
      assert((await focusedRow(page)) === 'dock:99', 'focus left the last row')
      await page.keyboard.press('Enter')
      const opened = (await events(page)).filter((event) => event.action === 'open')
      assert(opened.at(-1)?.id === 'dock:99', `Enter opened ${opened.at(-1)?.id}`)
    })
  )

  for (const [label, options] of [
    ['normal height', {}],
    ['a 340 x 250 pane', { width: 340, height: 250 }]
  ]) {
    await check(`a full click on Jump to latest over the open card jumps (${String(label)})`, () =>
      scene(options.height ? 'jumpFolded300' : 'jumpFolded720', options, async (page) => {
        await toggle(page).click()
        await card(page).waitFor()
        await page.waitForTimeout(200)
        const jump = page.getByRole('button', { name: 'Jump to latest' })
        const box = await jump.boundingBox()
        assert(box.y >= 0, `Jump to latest is off the pane at y=${box.y}`)
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(250)
        const atEnd = await page.evaluate(() => {
          const element = document.querySelector('[data-fixture-transcript]')
          return element.scrollTop + element.clientHeight >= element.scrollHeight - 2
        })
        assert(atEnd, 'the click did not jump to the end')
      })
    )
  }

  const toTop = (page, pane = page) =>
    pane.locator('[data-fixture-transcript]').evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
  const atEnd = (pane) =>
    pane
      .locator('[data-fixture-transcript]')
      .evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)
  // Jump to latest is either wholly in the pane and one click jumps, or (a pane too short for the
  // card and Jump both) out of reach entirely while the card is open and back once it folds.
  const jumpWorks = async (page) => {
    const jump = page.getByRole('button', { name: 'Jump to latest' })
    if (!(await jump.isVisible())) {
      await toggle(page).click()
      await card(page).waitFor({ state: 'detached' })
      // Jump returns once the 280ms fold has finished.
      await page.waitForTimeout(400)
    }
    const box = await jump.boundingBox()
    assert(box.y >= 0, `Jump to latest is off the pane at y=${box.y}`)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(250)
    assert(await atEnd(page), 'one click did not jump to the end')
  }

  await check(
    'Jump to latest stays wholly reachable as Clear failed appears and the message box grows',
    () =>
      scene('jumpFolded300', { width: 340, height: 250 }, async (page) => {
        await toggle(page).click()
        await card(page).waitFor()
        await page.evaluate(() => window.__workerDockHarness.fail('Another failure'))
        await page.getByRole('button', { name: /Clear all/ }).waitFor()
        await page.waitForTimeout(200)
        await shot?.(page, 'jump-short-pane-open')
        await jumpWorks(page)
        if (!(await expanded(page))) {
          await toggle(page).click()
          await card(page).waitFor()
        }
        await toTop(page)
        await page.locator('[data-fixture-composer]').evaluate((element) => {
          element.style.height = '96px'
        })
        await page.waitForTimeout(300)
        await jumpWorks(page)
      })
  )

  await check(
    'a detail read held across a roster change is not asked again, and a fresh one follows a stale reply',
    () =>
      scene('lazyHundredOpen720', {}, async (page) => {
        await page.evaluate(() => window.__workerDockHarness.holdReads())
        await page.locator('[data-worker-dock-open]').first().focus()
        await page.keyboard.press('End')
        await focusedIs(page, 'dock:99')
        await page.waitForTimeout(200)
        await page.evaluate(() => window.__workerDockHarness.start('Newer metadata'))
        await page.waitForTimeout(150)
        for (let press = 0; press < 4; press++) {
          await page.keyboard.press('End')
          await page.waitForTimeout(100)
        }
        // Rows in view may shift with the new worker and ask for their own window; a held one is
        // never asked for twice.
        const reads = await page.evaluate(() => window.__workerDockHarness.reads)
        const repeated = reads.filter((anchor, index) => reads.indexOf(anchor) !== index)
        assert(reads.includes('dock:99'), `the last row was never asked for: ${reads.join()}`)
        assert(repeated.length === 0, `held reads were asked again: ${repeated.join()}`)
        await page.evaluate(() => window.__workerDockHarness.releaseReads(true))
        await page.waitForTimeout(150)
        await page.keyboard.press('End')
        await page.waitForTimeout(100)
        const last = await focusedRow(page)
        assert(last, 'End left the list')
        await loaded(page, last)
        await page.keyboard.press('Enter')
        const opened = (await events(page)).filter((event) => event.action === 'open')
        assert(
          opened.at(-1)?.id === last,
          `Enter opened ${opened.at(-1)?.id}, focus was on ${last}`
        )
      })
  )

  await check('another pane’s Jump to latest folds this pane’s card; its own does not', () =>
    scene('twoPanesCommand720', { width: 760 }, async (page) => {
      const [first, second] = [0, 1].map((pane) => page.locator(`[data-fixture-pane="${pane}"]`))
      await toTop(page, first)
      await page.waitForTimeout(200)
      await first.getByRole('button', { name: 'Jump to latest' }).click()
      await page.waitForTimeout(250)
      assert(await atEnd(first), 'pane one did not jump')
      assert(await expanded(first), 'pane one’s own Jump folded its card')
      assert(!(await expanded(second)), 'pane two’s card stayed open')
    })
  )
}
