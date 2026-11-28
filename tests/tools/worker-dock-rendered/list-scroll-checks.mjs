// The open list's height, scrolling and place in the pane at several widths and pane heights.
// Imported by run.mjs.
import { card, region, scrollState, toggle } from './fixture-session.mjs'

export async function runListScrollChecks({ check, scene, assert, shot }) {
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
            assert(first.client <= 6 * 32 + 1, `list is ${first.client}px, more than six rows`)
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
            // The chip heads the open panel; the panel ends 8px above the message box.
            assert(Math.abs(pillBox.y - (cardBox.y + 1)) <= 1, 'the chip does not head the panel')
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
}
