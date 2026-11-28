// The chip's hover opening and its one-shape morph into the list. Imported by run.mjs.
import { chip, events, expanded, toggle } from './fixture-session.mjs'

const away = (page) => page.mouse.move(2, 2)
// From outside the chip, so the pointer always enters it (the warm page may have left it there).
const rest = async (page) => {
  await away(page)
  const box = await chip(page).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

// The chip's box on every frame for `ms`, starting now.
const frames = (page, ms) =>
  page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const element = document.querySelector('[data-worker-dock-morph]')
        const out = []
        const start = performance.now()
        const step = () => {
          const box = element.getBoundingClientRect()
          out.push({ width: box.width, height: box.height })
          if (performance.now() - start < ms) {
            requestAnimationFrame(step)
          } else {
            resolve(out)
          }
        }
        step()
      }),
    ms
  )

export async function runMorphChecks({ check, scene, assert }) {
  await check('a resting pointer opens the chip after a beat, and leaving folds it', () =>
    scene('twentyFolded720', {}, async (page) => {
      // The warm page may have left the pointer where the chip now draws.
      await away(page)
      await page.waitForTimeout(400)
      assert(!(await expanded(page)), 'starts open')
      await rest(page)
      await page.waitForTimeout(50)
      assert(!(await expanded(page)), 'opened before the open delay')
      await page.waitForTimeout(250)
      assert(await expanded(page), 'a resting pointer did not open it')
      await away(page)
      await page.waitForTimeout(100)
      assert(await expanded(page), 'folded before the close delay')
      await page.waitForTimeout(400)
      assert(!(await expanded(page)), 'leaving did not fold it')
      // A pointer passing straight over the chip does not open it.
      await rest(page)
      await page.waitForTimeout(40)
      await away(page)
      await page.waitForTimeout(300)
      assert(!(await expanded(page)), 'a passing pointer opened it')
    })
  )

  await check('width and height grow together, without overshoot', () =>
    scene('twentyFolded720', {}, async (page) => {
      const folded = await chip(page).boundingBox()
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      const seen = await frames(page, 450)
      const last = seen.at(-1)
      assert(last.width > folded.width + 100, `open width ${last.width}`)
      const between = (value, from, to) => value > from + 2 && value < to - 2
      assert(
        seen.some(
          (box) =>
            between(box.width, folded.width, last.width) &&
            between(box.height, folded.height, last.height)
        ),
        'no frame had both width and height in flight'
      )
      assert(
        seen.every((box) => box.width <= last.width + 0.5 && box.height <= last.height + 0.5),
        'the shape overshot its open size'
      )
    })
  )

  await check('a lone worker opens from its title width, never narrower', () =>
    scene('oneFolded720', {}, async (page) => {
      const folded = await chip(page).boundingBox()
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      const seen = await frames(page, 450)
      const narrowest = Math.min(...seen.map((box) => box.width))
      assert(narrowest >= folded.width - 1, `shrank to ${narrowest}px from ${folded.width}px`)
      // Folded and reopened four frames in, it turns back from where it is: every frame within
      // one frame's travel of the last, then widening.
      await page.waitForTimeout(400)
      const turn = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const element = document.querySelector('[data-worker-dock-morph]')
            const toggle = document.querySelector('[data-worker-dock-pill]')
            const widths = []
            toggle.click()
            const step = () => {
              widths.push(element.getBoundingClientRect().width)
              if (widths.length === 4) {
                toggle.click()
              }
              if (widths.length < 14) {
                requestAnimationFrame(step)
              } else {
                resolve(widths)
              }
            }
            requestAnimationFrame(step)
          })
      )
      const leaps = turn.slice(1).map((width, index) => Math.abs(width - turn[index]))
      assert(Math.max(...leaps) < 160, `width leapt: ${turn.map(Math.round)}`)
      const after = turn.slice(5)
      assert(
        after.every((width, index) => index === 0 || width >= after[index - 1] - 0.5),
        `did not turn back to widen: ${turn.map(Math.round)}`
      )
    })
  )

  await check('under reduced motion the chip opens at once', () =>
    scene('twentyFolded720', {}, async (page) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const folded = await chip(page).boundingBox()
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      const [first] = await frames(page, 0)
      await page.emulateMedia({ reducedMotion: null })
      assert(first.height > folded.height + 100, `first frame is ${first.height}px tall`)
    })
  )

  await check('Escape folds a pointer-opened chip before the message box takes it', () =>
    scene('twentyFolded720', {}, async (page) => {
      // As the real message box does: it takes Escape (to stop a turn) and prevents the default.
      await page.locator('[data-fixture-composer]').evaluate((element) => {
        window.__composerEscapes = 0
        element.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            window.__composerEscapes++
          }
        })
      })
      await page.locator('[data-fixture-composer]').focus()
      await rest(page)
      await page.waitForTimeout(300)
      assert(await expanded(page), 'a resting pointer did not open it')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(100)
      assert(!(await expanded(page)), 'Escape did not fold it')
      const inComposer = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-fixture-composer')
      )
      assert(inComposer, 'focus left the message box')
      const taken = await page.evaluate(() => window.__composerEscapes)
      assert(taken === 0, 'the message box also took the Escape')
      // Folded, Escape is the message box's again.
      await page.keyboard.press('Escape')
      assert((await page.evaluate(() => window.__composerEscapes)) === 1, 'Escape stayed taken')
    })
  )

  await check('Escape from a row of a pointer-opened list returns focus to the chip', () =>
    scene('twentyFolded720', {}, async (page) => {
      await rest(page)
      await page.waitForTimeout(300)
      await toggle(page).focus()
      await page.keyboard.press('ArrowDown')
      const inRow = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-worker-dock-row]'))
      )
      assert(inRow, 'ArrowDown did not reach a row')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      assert(!(await expanded(page)), 'Escape did not fold it')
      const onChip = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-worker-dock-pill')
      )
      assert(onChip, 'focus did not return to the chip')
    })
  )

  await check('a press where the chip was, as it opens under the pointer, pins the list', () =>
    scene('twentyFolded720', {}, async (page) => {
      await rest(page)
      const spot = await chip(page).boundingBox()
      await page.waitForTimeout(400)
      assert(await expanded(page), 'a resting pointer did not open it')
      // Rows now fill the spot the folded chip had; the press must not open one.
      await page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2)
      await away(page)
      await page.waitForTimeout(500)
      assert(await expanded(page), 'the press did not pin it open')
      // As a press on the chip would, it brings focus to the chip, so Escape folds the list.
      const onChip = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-worker-dock-pill')
      )
      assert(onChip, 'the pinning press left focus where it was')
      const opened = (await events(page)).filter((event) => event.action === 'open')
      assert(opened.length === 0, `the press opened ${opened.map((event) => event.id)}`)
      // Pinned, a press on a row opens it as usual.
      await page.locator('[data-worker-dock-open]').first().click()
      const after = (await events(page)).filter((event) => event.action === 'open')
      assert(after.length === 1, 'a pinned list did not open its row')
    })
  )

  await check('a press there dragged away leaves nothing behind: Enter still toggles', () =>
    scene('twentyFolded720', {}, async (page) => {
      await rest(page)
      const spot = await chip(page).boundingBox()
      await page.waitForTimeout(400)
      await page.mouse.move(spot.x + spot.width / 2, spot.y + spot.height / 2)
      await page.mouse.down()
      await page.mouse.move(4, 4)
      await page.mouse.up()
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      assert(!(await expanded(page)), 'Enter did not fold it after a dragged-away press')
    })
  )

  await check('Enter toggles a chip the pointer opened; a click pins it', () =>
    scene('twentyFolded720', {}, async (page) => {
      await rest(page)
      await page.waitForTimeout(300)
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(50)
      assert(!(await expanded(page)), 'Enter did not fold the pointer-opened chip')
      await away(page)
      await rest(page)
      await page.waitForTimeout(300)
      await page.locator('[data-worker-dock-pill-title]').click()
      await away(page)
      await page.waitForTimeout(500)
      assert(await expanded(page), 'a click did not pin it open')
    })
  )

  await check('after Escape, focus never lands in the folding rows', () =>
    scene('twentyFolded720', {}, async (page) => {
      await toggle(page).focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
      // Forward from the chip, where the rows would come next.
      await page.keyboard.press('Tab')
      const inRow = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-worker-dock-row]'))
      )
      assert(!inRow, 'Tab moved into a folding row')
    })
  )

  // Rows in the list's view that are still below full opacity.
  const fading = (page) =>
    page.evaluate(() => {
      const list = document.querySelector('[data-worker-dock-card] [role="region"]')
      const bounds = list.getBoundingClientRect()
      return [...list.querySelectorAll('[data-worker-dock-morph-row]')].filter((row) => {
        const box = row.getBoundingClientRect()
        return (
          box.bottom > bounds.top &&
          box.top < bounds.bottom &&
          Number(getComputedStyle(row).opacity) < 0.99
        )
      }).length
    })
  const scrollList = (page) =>
    page
      .locator('[data-worker-dock-card] [role="region"]')
      .evaluate((element) => element.scrollTo({ top: 2000 }))

  await check('rows a scrolled list mounts show at once, open or still opening', () =>
    scene('lazyHundredOpen720', {}, async (page) => {
      await page.waitForTimeout(700)
      await scrollList(page)
      await page.waitForTimeout(60)
      const open = await fading(page)
      assert(open === 0, `open: ${open} rows in view are still fading in`)
      await toggle(page).focus()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      await page.keyboard.press('Enter')
      // The shape has landed; the opening's rows may still be rising, but scrolled-in ones show.
      await page.waitForTimeout(320)
      await scrollList(page)
      await page.waitForTimeout(60)
      const opening = await fading(page)
      assert(opening === 0, `opening: ${opening} scrolled-in rows in view are still fading in`)
    })
  )
}
