// Workers and background commands in one card: groups, keyboard across them, and the header's
// Stop/Clear actions at narrow widths. Scenes come from the WorkerDockCommandGroup fixture.
import { events, focusedRow, region, rows, toggle } from './fixture-session.mjs'

const fixture = 'native-chat/tools/tasks/dock/WorkerDockCommandGroup'

export async function runCommandGroupChecks({ check, scene, assert, open, shot }) {
  await check('a mixed card names both groups and keeps commands out of the worker count', () =>
    scene('mixedOpen', { fixture, width: 420 }, async (page) => {
      assert(
        (await region(page).getAttribute('aria-label')) === 'Workers and background commands',
        'region name'
      )
      const workers = page.locator('[role="group"][aria-label="Workers"] [data-worker-dock-open]')
      const commands = page.locator(
        '[role="group"][aria-label="Background commands"] [data-worker-dock-open]'
      )
      assert((await workers.count()) === 3, `worker rows ${await workers.count()}`)
      assert((await commands.count()) === 2, `command rows ${await commands.count()}`)
      assert(
        (await page.locator('[data-worker-dock-group-label]').count()) === 1,
        'one group label'
      )
      // The header reads like the chip: what needs you or runs, or the two counts.
      const header = ((await toggle(page).textContent()) ?? '').replace(/\s+/g, ' ')
      assert(/(^\d+ running$)|3 workers · 2 commands$/.test(header), `header "${header}"`)
    })
  )

  await check('ArrowDown moves from the last worker row to the first command row', () =>
    scene('mixedOpen', { fixture, width: 420 }, async (page) => {
      const all = await rows(page)
      const workers = page.locator('[role="group"][aria-label="Workers"] [data-worker-dock-open]')
      await workers.last().focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(150)
      const focused = await focusedRow(page)
      const firstCommand = await page
        .locator('[role="group"][aria-label="Background commands"] [data-worker-dock-row]')
        .first()
        .getAttribute('data-worker-dock-row')
      assert(focused === firstCommand, `focus on ${focused}, rows ${all.length}`)
    })
  )

  await check('a commands-only chip says background commands, not workers', () =>
    scene('commandsOnlyFolded', { fixture, width: 420 }, async (page) => {
      const text = (await toggle(page).textContent()) ?? ''
      assert(/^2 background commands$/.test(text.trim()), `chip "${text}"`)
      assert(
        (await toggle(page).locator('[data-worker-dock-terminal]').count()) === 1,
        'no terminal mark'
      )
    })
  )

  for (const [name, width, clear] of [
    ['actionsStopClear320', 320, false],
    ['actionsStopClear420', 420, false],
    ['actionsStopClear560', 560, true],
    ['actionsStopClearShort320', 320, false],
    ['actionsStopClearShort420', 420, false],
    ['actionsStopClearShort560', 560, true]
  ]) {
    await check(`the header keeps its actions on one row and a whole Stop label (${name})`, () =>
      scene(name, { fixture, width: width + 40 }, async (page) => {
        const footer = page.locator('[data-worker-dock-actions]')
        const stop = footer.getByRole('button', { name: 'Stop subagents and commands' })
        const fits = await stop.evaluate((element) => element.scrollWidth <= element.clientWidth)
        assert(fits, 'Stop label is cut')
        const clearButton = footer.getByRole('button', { name: /^Clear all/ })
        assert((await clearButton.isVisible()) === clear, `Clear visible: ${!clear}`)
        if (clear) {
          const [a, b] = await Promise.all([clearButton.boundingBox(), stop.boundingBox()])
          assert(Math.abs(a.y - b.y) <= 1, 'Clear and Stop are not on one row')
        }
        const [box, footerBox] = await Promise.all([stop.boundingBox(), footer.boundingBox()])
        assert(box.x + box.width <= footerBox.x + footerBox.width + 0.5, 'Stop overflows')
      })
    )
  }

  await check('a focused Clear that a narrower pane sets aside hands focus to the chip', () =>
    scene('actionsStopClear560', { fixture, width: 600 }, async (page) => {
      const clearButton = page.locator('[data-worker-dock-actions]').getByRole('button', {
        name: /^Clear all/
      })
      await clearButton.focus()
      await page
        .locator('[data-native-chat-root]')
        .evaluate((pane) => pane.style.setProperty('width', '320px'))
      await page.waitForTimeout(200)
      assert(!(await clearButton.isVisible()), 'Clear did not step aside')
      const onChip = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-worker-dock-pill')
      )
      assert(onChip, 'focus fell to the page')
    })
  )

  await check('Stop all shows in the header only when it applies, names its scope, and stops', () =>
    scene('stopAllOpen720', {}, async (page) => {
      // Orchestration workers only, with the chat's own stop offered: it names what it may end
      // (work the roster does not list), never "Stop all", which would include the workers.
      const footer = page.locator('[data-worker-dock-actions]')
      const stop = footer.getByRole('button', { name: 'Stop subagents and commands' })
      assert((await stop.count()) === 1, 'no scoped Stop in the header')
      assert(
        (await stop.getAttribute('aria-describedby')) !== null,
        'Stop does not say the workers keep running'
      )
      const [box, header, list] = await Promise.all([
        stop.boundingBox(),
        toggle(page).boundingBox(),
        region(page).boundingBox()
      ])
      assert(
        Math.abs(box.y + box.height / 2 - (header.y + header.height / 2)) <= 1,
        'Stop is not in the header'
      )
      assert(box.y + box.height <= list.y + 1, 'Stop is not above the rows')
      await stop.click()
      assert(
        (await events(page)).some((event) => event.action === 'stop-all'),
        'no Stop all'
      )
      await shot(page, 'header-stop-all')
      await open('fourOpen720', {})
      assert(
        (await page.getByRole('button', { name: /^Stop (all|subagents|commands)/ }).count()) === 0,
        'Stop all drawn'
      )
      assert(
        (await page.locator('[data-worker-dock-actions]').count()) === 0,
        'empty actions drawn'
      )
    })
  )

  await check(
    'a virtualized mixed card crosses the groups by keyboard and measures the label row',
    () =>
      scene('manyMixedOpen', { fixture, width: 420 }, async (page) => {
        const opener = (index) =>
          page.locator(`[data-index="${index}"] [data-worker-dock-open]`).first()
        await opener(0).focus()
        // A virtualized move focuses its row once drawn, a frame or more later (focus can rest on
        // the page meanwhile): wait until the row at the destination index has it.
        const focusedIndex = () =>
          page.evaluate(
            () =>
              document.activeElement?.closest('[data-index]')?.getAttribute('data-index') ?? null
          )
        const press = async (key, destination) => {
          await page.keyboard.press(key)
          await page
            .waitForFunction(
              (index) =>
                document.activeElement?.closest('[data-index]')?.getAttribute('data-index') ===
                String(index),
              destination,
              { timeout: 3000 }
            )
            .catch(() => {})
          assert(
            (await focusedIndex()) === String(destination),
            `${key} did not reach row ${destination}`
          )
        }
        for (let step = 1; step <= 24; step++) {
          await press('ArrowDown', step)
        }
        const lastWorker = await focusedRow(page)
        await press('ArrowDown', 25)
        const firstCommand = await focusedRow(page)
        const commandRow = page.locator('[data-index="25"]')
        assert(
          (await commandRow.getAttribute('data-index')) === '25' &&
            firstCommand ===
              (await commandRow
                .locator('[data-worker-dock-row]')
                .getAttribute('data-worker-dock-row')),
          `ArrowDown from ${lastWorker} focused ${firstCommand}`
        )
        assert(
          (await commandRow.locator('[data-worker-dock-group-label]').count()) === 1,
          'the label is not in the first command row'
        )
        // The label is measured with its row: the next row starts below it, not over it.
        const [labelled, next] = await Promise.all([
          commandRow.boundingBox(),
          page.locator('[data-index="26"]').boundingBox()
        ])
        assert(next && labelled && next.y >= labelled.y + labelled.height - 1, 'rows overlap')
        await press('End', 34)
        const last = await page
          .locator('[data-index="34"] [data-worker-dock-row]')
          .getAttribute('data-worker-dock-row')
        assert((await focusedRow(page)) === last, 'End did not reach the last command')
        await press('Home', 0)
        const first = await page
          .locator('[data-index="0"] [data-worker-dock-row]')
          .getAttribute('data-worker-dock-row')
        assert((await focusedRow(page)) === first, 'Home did not reach the first worker')
      })
  )
}
