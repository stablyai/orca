// Checks for rows whose details load late, monitoring with no listed rows, dialogs a row opens,
// and Jump to latest over the open card. Imported by run.mjs.
import { card, events, expanded, focusedRow, toggle } from './fixture-session.mjs'

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
  await check('incomplete monitoring with no listed rows keeps the pill and Stop all', () =>
    scene('unlistedOpen720', {}, async (page) => {
      const title = await toggle(page).getAttribute('aria-label')
      assert(title === 'Background work running', `pill says "${title}"`)
      assert(!(await card(page).textContent()).includes('unavailable'), 'card says unavailable')
      await page.getByRole('button', { name: 'Stop all' }).click()
      assert(
        (await events(page)).some((event) => event.action === 'stop-all'),
        'no Stop all'
      )
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
        await page.waitForTimeout(200)
        const jump = page.getByRole('button', { name: 'Jump to latest' })
        const [a, c] = await Promise.all([jump.boundingBox(), card(page).boundingBox()])
        const gap = c.y - (a.y + a.height)
        assert(Math.abs(gap - 8) <= 1, `Jump to latest sits ${gap}px above the open card`)
        const hit = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? '',
          [a.x + a.width / 2, a.y + a.height / 2]
        )
        assert(hit.includes('Jump to latest'), `the point over Jump hits "${hit}"`)
        await toggle(page).click()
        await page.waitForTimeout(200)
        const [b, p] = await Promise.all([jump.boundingBox(), toggle(page).boundingBox()])
        assert(
          Math.abs(p.y + p.height - (b.y + b.height)) <= 1 && b.x >= p.x + p.width,
          'Jump did not settle back onto the chip row'
        )
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

  for (const [how, removed] of [
    ['Close', false],
    ['Escape', false],
    ['Close', true],
    ['Escape', true]
  ]) {
    await check(
      `a settled result closed by ${how}${removed ? ' after its row left' : ''} returns focus in its own pane`,
      () =>
        scene('twoPanesCommand720', { width: 760 }, async (page) => {
          const pane = page.locator('[data-fixture-pane="1"]')
          await pane.locator(`${rowOf('dock:0')} [data-worker-dock-open]`).click()
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          if (removed) {
            await page.evaluate(() => window.__workerDockHarnesses[1].finish('dock:0'))
            await pane.locator(rowOf('dock:0')).waitFor({ state: 'detached' })
          }
          await (how === 'Close'
            ? dialog.getByRole('button', { name: 'Close' }).click()
            : page.keyboard.press('Escape'))
          await dialog.waitFor({ state: 'detached' })
          await page.waitForTimeout(100)
          const where = await page.evaluate(() => {
            const active = document.activeElement
            return {
              pane: active?.closest('[data-fixture-pane]')?.getAttribute('data-fixture-pane'),
              row: active?.closest('[data-worker-dock-row]')?.getAttribute('data-worker-dock-row'),
              pill: active?.hasAttribute('data-worker-dock-pill') ?? false
            }
          })
          const expected = removed ? where.pill : where.row === 'dock:0'
          assert(where.pane === '1' && expected, `focus went to ${JSON.stringify(where)}`)
        })
    )
  }

  for (const [label, options] of [
    ['normal height', {}],
    ['a 300 x 250 pane', { width: 340, height: 250 }]
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
      await page.waitForTimeout(200)
    }
    const box = await jump.boundingBox()
    assert(box.y >= 0, `Jump to latest is off the pane at y=${box.y}`)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(250)
    assert(await atEnd(page), 'one click did not jump to the end')
  }

  await check(
    'Jump to latest stays wholly reachable as the footer appears and the message box grows',
    () =>
      scene('jumpFolded300', { width: 340, height: 250 }, async (page) => {
        await toggle(page).click()
        await card(page).waitFor()
        await page.evaluate(() => window.__workerDockHarness.fail('Another failure'))
        await page.locator('[data-worker-dock-footer]').waitFor()
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

  for (const [when, early] of [
    ['while its result is loading', true],
    ['while its result is open', false]
  ]) {
    await check(
      `when the last worker leaves ${when}, closing its result focuses the message box`,
      () =>
        scene('lastFailedDetails720', {}, async (page) => {
          await page.locator(`${rowOf('dock:0')} [data-worker-dock-open]`).click()
          if (early) {
            await page.evaluate(() => window.__workerDockHarness.finish('dock:0'))
          }
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          if (!early) {
            await page.evaluate(() => window.__workerDockHarness.finish('dock:0'))
          }
          await page.locator('[data-worker-dock-pill]').waitFor({ state: 'detached' })
          await page.keyboard.press('Escape')
          await dialog.waitFor({ state: 'detached' })
          await page.waitForTimeout(100)
          const onComposer = await page.evaluate(() =>
            document.activeElement?.hasAttribute('data-fixture-composer')
          )
          assert(onComposer, 'focus did not land on the pane’s message box')
        })
    )
  }

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
