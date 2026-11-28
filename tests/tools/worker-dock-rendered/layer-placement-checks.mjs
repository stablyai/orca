// Where the folded chip sits over each card the dock can stack above the message box: centered,
// 8px above it, at every width and theme; and above a docked task list, with the transcript
// running on under it. Imported by run.mjs.
import { card, chip, expanded, toggle } from './fixture-session.mjs'

export async function runLayerPlacementChecks({ check, scene, assert, shot }) {
  for (const width of [720, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      for (const layer of ['question', 'queue', 'both']) {
        await check(`sits centered just above the ${layer} (${width}px, ${theme})`, () =>
          scene(`${layer}${width}`, { width: width + 40, height: 900, theme }, async (page) => {
            const sibling =
              layer === 'queue'
                ? page.locator('[data-native-chat-queue] .rounded-lg').first()
                : page.locator('[data-native-chat-question-card] [data-native-chat-dock-clip]')
            const [a, b] = await Promise.all([chip(page).boundingBox(), sibling.boundingBox()])
            assert(a && b, 'chip or next card missing')
            const gap = b.y - a.y - a.height
            assert(Math.abs(gap - 8) <= 1, `gap is ${gap}px`)
            const offset = a.x + a.width / 2 - (b.x + b.width / 2)
            assert(Math.abs(offset) <= 1, `chip is ${offset}px off the next card's center`)
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

  const stack = 'native-chat/tools/tasks/dock/WorkerDockStack'
  for (const width of [1000, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      await check(
        `eight workers: the chip sits above the tasks, the chat runs under it (${width}px, ${theme})`,
        () =>
          scene(
            `eightTasksMid${width}`,
            { fixture: stack, width: width + 40, height: 900, theme },
            async (page) => {
              const tasks = page.getByRole('button', { name: /Tasks/ }).first()
              const jump = page.getByRole('button', { name: 'Jump to latest' })
              await jump.waitFor()
              const [a, t, j, view] = await Promise.all([
                chip(page).boundingBox(),
                tasks.boundingBox(),
                jump.boundingBox(),
                page.locator('[data-fixture-transcript]').boundingBox()
              ])
              const end = view.y + view.height
              assert(
                a.y + a.height <= t.y - 7 && a.y + a.height >= t.y - 9,
                `chip ends ${t.y - a.y - a.height}px above the tasks`
              )
              const offset = a.x + a.width / 2 - (t.x + t.width / 2)
              assert(Math.abs(offset) <= 1, `chip is ${offset}px off the tasks' center`)
              assert(
                Math.abs(a.y + a.height - end) <= 1,
                `chip ends ${end - a.y - a.height}px from the transcript's end`
              )
              assert(j.y + j.height <= a.y - 11, 'Jump to latest overlaps the chip')
              // The chat runs on under the chip: some transcript line sits behind it.
              const behind = await page.evaluate(() => {
                const chipBox = document
                  .querySelector('[data-worker-dock-morph]')
                  .getBoundingClientRect()
                return [...document.querySelectorAll('[data-fixture-transcript] p')].some(
                  (line) => {
                    const box = line.getBoundingClientRect()
                    return box.bottom > chipBox.top && box.top < chipBox.bottom
                  }
                )
              })
              assert(behind, 'no transcript line runs under the chip')
              await shot(page, `tasks-mid-${width}-${theme}`)
            }
          )
      )
    }
  }

  await check('eight workers at the end of the chat: the last line clears the chip', () =>
    scene('eightTasksEnd390', { fixture: stack, width: 430, height: 900 }, async (page) => {
      await page.waitForTimeout(300)
      const [line, a] = await Promise.all([
        page.locator('[data-fixture-last-line]').boundingBox(),
        chip(page).boundingBox()
      ])
      assert(
        line.y + line.height <= a.y,
        `last line ends at ${line.y + line.height}, chip at ${a.y}`
      )
    })
  )

  await check('the chip keeps its state when the list it draws in is replaced', () =>
    scene('hostedTwentyFolded720', { height: 900 }, async (page) => {
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(400)
      assert(await expanded(page), 'the chip did not open')
      await page.evaluate(() => document.querySelector('[data-fixture-remount-list]').click())
      await page.waitForTimeout(300)
      assert(await expanded(page), 'replacing the list folded the card')
      const onChip = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-worker-dock-pill')
      )
      assert(onChip, 'the move dropped focus from the chip')
      // Focus the user then takes elsewhere (a press on the transcript) stays theirs on the next move.
      const transcript = await page.locator('[data-fixture-transcript]').boundingBox()
      await page.mouse.click(transcript.x + 20, transcript.y + 20)
      await page.evaluate(() => document.querySelector('[data-fixture-remount-list]').click())
      await page.waitForTimeout(300)
      const pulled = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-worker-dock-pill')
      )
      assert(!pulled, 'a later move pulled focus back to the chip')
      await toggle(page).click()
      await page.waitForTimeout(400)
      const placed = await page.evaluate(() => {
        const list = document.querySelector('[data-fixture-list-epoch="2"]')
        const slot = list?.querySelector('[data-native-chat-worker-chip-slot]')
        const tasks = slot?.nextElementSibling?.getBoundingClientRect()
        const card = document.querySelector('[data-worker-dock-card]').getBoundingClientRect()
        return {
          inNewList: Boolean(slot?.querySelector('[data-worker-dock-card]')),
          room: list?.style.getPropertyValue('--native-chat-worker-chip-room') ?? '',
          aboveTasks: tasks ? card.bottom <= tasks.top + 1 : false
        }
      })
      assert(placed.inNewList, 'the card is not in the new list')
      assert(placed.room !== '', 'the new list never got the chip room')
      assert(placed.aboveTasks, 'the card is not above the task list')
      await toggle(page).click()
      await page.waitForTimeout(400)
      const folded = await card(page).count()
      assert(folded === 0, 'the moved card does not fold')
    })
  )
}
