// Every row above the message box shares one left and one right edge. Measures real bounding boxes
// in headless Chromium at 320, 390 and 720px, light and dark, with and without the goal, the queue,
// a failed chip, the open panel and a prompt card. Start the fixture server
// (`pnpm dev:fixtures --port 5600 --strictPort`), then run
// `node tests/tools/worker-dock-rendered/dock-alignment.mjs [baseUrl] [shotDir]`.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createFixtureSession } from './fixture-session.mjs'

const base = process.argv[2] ?? 'http://127.0.0.1:5600'
const shots = process.argv[3]
const { browser, results, open, check, assert } = await createFixtureSession({
  base,
  fixture: 'native-chat/tools/tasks/dock/DockAlignment'
})

// The first bordered box at or under each row's root. The folded chip hugs its label and sits
// centered over the rows, so it is checked for its center instead of its edges.
const ROWS = [
  ['chip', '[data-worker-dock-morph="closed"]'],
  ['panel', '[data-worker-dock-card]'],
  ['goal', '[data-native-chat-thread-goal]'],
  ['queued', '[data-native-chat-queue]'],
  ['prompt', '[data-native-chat-question-card]'],
  ['composer', '[data-composer-field] [data-native-chat-dock-pinned]']
]

const measure = (page) =>
  page.evaluate((rows) => {
    const bordered = (root) =>
      [root, ...root.querySelectorAll('*')].find((element) => {
        const style = getComputedStyle(element)
        return (
          Number.parseFloat(style.borderLeftWidth) > 0 &&
          Number.parseFloat(style.borderRightWidth) > 0
        )
      })
    return rows.flatMap(([name, selector]) => {
      const root = document.querySelector(selector)
      const box = root && bordered(root)
      if (!box) {
        return []
      }
      const rect = box.getBoundingClientRect()
      const icon = box.querySelector('svg, [data-worker-dock-glyph]')
      return [
        {
          name,
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          icon: icon ? Math.round(icon.getBoundingClientRect().left * 10) / 10 : null
        }
      ]
    })
  }, ROWS)

const VARIANTS = ['full', 'open', 'failed', 'bare', 'goalOnly', 'prompt']
for (const width of [320, 390, 720]) {
  for (const theme of ['light', 'dark']) {
    for (const variant of VARIANTS) {
      const scene = `${variant}${width}`
      await check(`one left and right edge: ${scene} ${theme}`, async () => {
        const { page } = await open(scene, { width: width + 40, height: 900, theme })
        await page.waitForTimeout(150)
        const rows = await measure(page)
        const table = rows
          .map((row) => `${row.name} L${row.left} R${row.right ?? '-'} I${row.icon ?? '-'}`)
          .join(' | ')
        console.log(`  ${scene} ${theme}: ${table}`)
        assert(
          rows.some((row) => row.name === 'composer' || row.name === 'prompt'),
          'no base row'
        )
        const edged = rows.filter((row) => row.name !== 'chip')
        const lefts = edged.map((row) => row.left)
        const rights = edged.map((row) => row.right)
        assert(Math.max(...lefts) - Math.min(...lefts) <= 1, `left edges differ: ${lefts}`)
        assert(Math.max(...rights) - Math.min(...rights) <= 1, `right edges differ: ${rights}`)
        const chip = rows.find((row) => row.name === 'chip')
        const center = (Math.min(...lefts) + Math.max(...rights)) / 2
        assert(
          !chip || Math.abs((chip.left + chip.right) / 2 - center) <= 1,
          `chip centered at ${chip && (chip.left + chip.right) / 2}, rows at ${center}`
        )
        assert(
          !chip || (chip.left >= Math.min(...lefts) - 1 && chip.right <= Math.max(...rights) + 1),
          'chip runs past the rows'
        )
        if (shots) {
          await page.evaluate(
            ([left, right]) => {
              for (const x of [left, right]) {
                const guide = document.createElement('div')
                guide.setAttribute('data-alignment-guide', '')
                guide.style.cssText = `position:fixed;top:0;bottom:0;left:${x - 0.5}px;width:0;border-left:1px dashed #ef4444;z-index:99999;pointer-events:none`
                document.body.append(guide)
              }
            },
            [Math.min(...lefts), Math.max(...rights)]
          )
          mkdirSync(shots, { recursive: true })
          await page.screenshot({ path: path.join(shots, `${scene}.${theme}.png`) })
          await page.evaluate(() =>
            document.querySelectorAll('[data-alignment-guide]').forEach((guide) => guide.remove())
          )
        }
      })
    }
  }
}

await browser.close()
const failed = results.filter((result) => !result.ok).length
console.log(`${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
