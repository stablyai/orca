// The chip's text and accessible name. Several workers read as a status count, the same folded and
// open; one worker reads as its title folded, and as its count once its row shows the title. With
// several workers the name starts with the visible text and names the latest one.
import { expanded, rows, toggle } from './fixture-session.mjs'

const STACK = 'native-chat/tools/tasks/dock/WorkerDockStack'

// The lead and the count after it are spaced with a no-break space.
const title = async (page) =>
  ((await toggle(page).locator('[data-worker-dock-pill-title]').textContent()) ?? '').replace(
    /\s+/g,
    ' '
  )
const firstRowTitle = (page) =>
  page.locator('[data-worker-dock-row]').first().locator('.truncate').first().textContent()

export async function runChipNameChecks({ check, scene, assert }) {
  for (const [count, total] of [
    ['fourOpen720', 4],
    ['twentyOpen720', 20]
  ]) {
    await check(`names the count and the most relevant worker on the chip (${count})`, () =>
      scene(count, {}, async (page) => {
        assert(await expanded(page), 'starts open')
        // The chip leads with what needs the user, else what runs, else the count.
        const states = (await rows(page)).map((row) => row.state)
        const attention = states.filter((state) =>
          ['failed', 'unexpected', 'needs-you'].includes(state)
        ).length
        const running = states.filter((state) =>
          ['running', 'starting', 'stopping'].includes(state)
        ).length
        const expected = attention
          ? `${attention} needs you · ${total} workers`
          : running
            ? `${running} running`
            : `${total} workers`
        const open = await title(page)
        assert(open === expected, `open chip shows "${open}", not "${expected}"`)
        const openName = await toggle(page).getAttribute('aria-label')
        assert(openName?.startsWith(`${open}, latest: `), `open chip named "${openName}"`)
        await toggle(page).click()
        const folded = await title(page)
        assert(folded === expected, `folded chip shows "${folded}", not "${expected}"`)
        const name = await toggle(page).getAttribute('aria-label')
        assert(name?.startsWith(`${folded}, latest: `), `folded chip named "${name}"`)
        // Once the 280ms fold has settled.
        await page.waitForTimeout(400)
        const box = await toggle(page).boundingBox()
        assert(Math.abs(box.height - 24) <= 1, `chip is ${box.height}px tall`)
      })
    )
  }

  await check('in a narrow pane the folded chip shows its whole label, centered', () =>
    scene('eightTasksMid320', { fixture: STACK, width: 360 }, async (page) => {
      const shape = await page.evaluate(() => {
        const title = document.querySelector('[data-worker-dock-pill-title]')
        const [lead, rest] = title.children
        const chip = document.querySelector('[data-worker-dock-morph]').getBoundingClientRect()
        const row = document.querySelector('[data-worker-dock-float]').getBoundingClientRect()
        return {
          parts: title.children.length,
          oneLine: rest ? rest.offsetTop === lead.offsetTop : true,
          offCenter: Math.abs(chip.left + chip.width / 2 - (row.left + row.width / 2))
        }
      })
      assert(shape.parts === 2, 'the chip label has no count after its lead')
      assert(shape.oneLine, 'the count after the lead wrapped out of view')
      assert(shape.offCenter <= 1, `the chip sits ${shape.offCenter}px off center`)
    })
  )

  await check('one worker: the folded chip is its title, and the title is its name', () =>
    scene('oneFolded720', {}, async (page) => {
      assert(!(await expanded(page)), 'starts folded')
      const folded = await title(page)
      assert((await toggle(page).getAttribute('aria-label')) === null, 'chip renamed')
      await toggle(page).click()
      const row = await firstRowTitle(page)
      assert(folded === row, `chip shows "${folded}", the row "${row}"`)
      const open = await title(page)
      assert(/^1 (running|worker|needs you · 1 worker)$/.test(open), `open chip shows "${open}"`)
    })
  )

  await check('the only failed worker: the chip is its title, with the failed dot', () =>
    scene('lastFailedDetails720', {}, async (page) => {
      if (await expanded(page)) {
        await toggle(page).click()
      }
      const text = await title(page)
      assert(text && !/^\d+ /.test(text), `chip shows "${text}"`)
      const dot = await toggle(page).locator('.bg-destructive').count()
      assert(dot === 1, 'chip lacks the failed dot')
    })
  )
}
