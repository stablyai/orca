// The chip's accessible name: it starts with the chip's visible text and names the latest worker;
// open, the header's visible text is its whole name.
import { expanded, toggle } from './fixture-session.mjs'

export async function runChipNameChecks({ check, scene, assert }) {
  for (const [count, label] of [
    ['oneFolded720', /^1 worker, latest: /],
    ['fourOpen720', /^4 workers, latest: /],
    ['twentyOpen720', /^20 workers, latest: /]
  ]) {
    await check(`names the count and the most relevant worker on the pill (${count})`, () =>
      scene(count, {}, async (page) => {
        const open = await expanded(page)
        // Open, the header's visible text is its whole name; fold to read the chip's name.
        assert(!open || (await toggle(page).getAttribute('aria-label')) === null, 'header renamed')
        const text = (await toggle(page).textContent()) ?? ''
        if (open) {
          await toggle(page).click()
        }
        const name = await toggle(page).getAttribute('aria-label')
        assert(label.test(name), `pill label "${name}"`)
        const total = Number(name.match(/^(\d+)/)[1])
        assert(
          name.startsWith((await toggle(page).textContent()) ?? '\0'),
          'name lacks the chip text'
        )
        if (open) {
          await toggle(page).click()
        }
        const shown = open ? /^Workers\s*(\d+)$/ : /^(\d+) workers?$/
        assert(Number(text.match(shown)?.[1]) === total, `pill shows "${text}"`)
        const box = await toggle(page).boundingBox()
        const tall = (await expanded(page)) ? 30 : 26
        assert(Math.abs(box.height - tall) <= 1, `pill is ${box.height}px tall`)
      })
    )
  }

  await check('a failed-only chip is named by its own text first', () =>
    scene('lastFailedDetails720', {}, async (page) => {
      if (await expanded(page)) {
        await toggle(page).click()
      }
      const text = await toggle(page).textContent()
      const name = await toggle(page).getAttribute('aria-label')
      assert(text === '1 failed', `chip shows "${text}"`)
      assert(name?.startsWith('1 failed, latest: '), `chip named "${name}"`)
    })
  )
}
