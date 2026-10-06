import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
process.env.ORCA_BACKGROUND_LAUNCH = '1'

function scrollInput(card) {
  return card.data.filter((value) =>
    card.kind === 'mouse'
      ? value.startsWith('\x1b[<64;') || value.startsWith('\x1b[<65;')
      : value === '\x1b[A' || value === '\x1b[B'
  )
}

await test('session grid wheel contract with real xterm and native browser scrolling', async (suite) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-scroll-contract-'))
  let browser
  try {
    const bundle = path.join(directory, 'fixture.js')
    await build({
      entryPoints: [path.join(import.meta.dirname, 'browser-fixture.tsx')],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: bundle,
      alias: { '@': path.resolve('src/renderer/src') },
      define: { 'process.env.NODE_ENV': '"development"' }
    })
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ORCA_SCROLL_BROWSER_CHANNEL
        ? { channel: process.env.ORCA_SCROLL_BROWSER_CHANNEL }
        : {})
    })
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    async function reset(mode, position = 'middle') {
      await page.goto('about:blank')
      await page.setContent('<div id="root"></div>')
      await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') })
      await page.addScriptTag({ path: bundle })
      await page.evaluate(
        async ({ mode, position }) => {
          await window.scrollHarness.seed()
          window.scrollHarness.mode(mode)
          window.scrollHarness.viewport('normal', position)
        },
        { mode, position }
      )
      await page.waitForTimeout(100)
    }
    async function state() {
      return page.evaluate(() => window.scrollHarness.state())
    }
    async function wheel(kind, deltaY, shift = false) {
      await page.locator(`#${kind} .xterm-screen`).hover()
      if (shift) {
        await page.keyboard.down('Shift')
      }
      await page.mouse.wheel(0, deltaY)
      if (shift) {
        await page.keyboard.up('Shift')
      }
      await page.waitForTimeout(250)
    }
    for (const mode of ['terminal', 'grid', 'focus']) {
      const shift = mode === 'grid'
      for (const [position, deltaY] of [
        ['middle', -120],
        ['middle', 120],
        ['top', -120],
        ['bottom', 120]
      ]) {
        await suite.test(
          `${mode}: normal ${position}, delta ${deltaY}, Shift ${shift}`,
          async () => {
            await reset(mode, position)
            if (mode === 'focus') {
              await page.evaluate(() => window.scrollHarness.focus('normal'))
            }
            const before = await state()
            await wheel('normal', deltaY, shift)
            const after = await state()
            assert.equal(after.grid, before.grid, 'terminal-owned wheel must never scroll grid')
            if (position === 'middle') {
              assert.equal(
                Math.sign(after.cards[0].viewport - before.cards[0].viewport),
                Math.sign(deltaY),
                'xterm history must actually move'
              )
            } else {
              assert.equal(after.cards[0].viewport, before.cards[0].viewport)
            }
          }
        )
      }
      for (const kind of ['mouse', 'alternate']) {
        await suite.test(`${mode}: ${kind} terminal input, Shift ${shift}`, async () => {
          await reset(mode)
          if (mode === 'focus') {
            await page.evaluate((kind) => window.scrollHarness.focus(kind), kind)
          }
          const before = await state()
          await wheel(kind, 120, shift)
          const after = await state()
          assert.equal(after.grid, before.grid)
          const data = after.cards.find((card) => card.kind === kind).data
          assert.ok(
            data.some((value) =>
              kind === 'mouse' ? value.startsWith('\x1b[<65;') : value === '\x1b[B'
            ),
            'real xterm must emit terminal scroll input'
          )
        })
      }
    }
    for (const kind of ['normal', 'mouse', 'alternate']) {
      await suite.test(`grid: unshifted wheel above ${kind} scrolls the grid`, async () => {
        await reset('grid')
        await wheel(kind, 120)
        assert.ok((await state()).grid > 0)
      })
    }
    for (const kind of ['normal', 'mouse', 'alternate']) {
      await suite.test(`focus: unfocused ${kind} scrolls grid without taking focus`, async () => {
        await reset('focus')
        const activeBefore = await page.evaluate(() => document.activeElement?.tagName)
        await wheel(kind, 120)
        const after = await state()
        assert.ok(after.grid > 0)
        assert.equal(after.activeTag, activeBefore)
        assert.deepEqual(scrollInput(after.cards.find((card) => card.kind === kind)), [])
      })
      await suite.test(`focus: Shift scrolls unfocused ${kind} without taking focus`, async () => {
        await reset('focus')
        const before = await state()
        await wheel(kind, -120, true)
        const after = await state()
        assert.equal(after.grid, 0)
        assert.equal(after.activeTag, before.activeTag)
        if (kind === 'normal') {
          assert.ok(after.cards[0].viewport < before.cards[0].viewport)
        } else {
          assert.ok(scrollInput(after.cards.find((card) => card.kind === kind)).length > 0)
        }
      })
    }
    await suite.test(
      'focus: click activates only that terminal; blur returns wheel to grid',
      async () => {
        await reset('focus')
        await page.locator('#normal .xterm-screen').click()
        const focused = await state()
        await wheel('normal', -120)
        const inside = await state()
        assert.equal(inside.grid, 0)
        assert.ok(inside.cards[0].viewport < focused.cards[0].viewport)
        await page.evaluate(() => window.scrollHarness.focus(null))
        await wheel('normal', 120)
        assert.ok((await state()).grid > 0)
      }
    )
    await suite.test(
      'focus: another hovered terminal cannot scroll the focused terminal',
      async () => {
        await reset('focus')
        await page.evaluate(() => window.scrollHarness.focus('normal'))
        const before = await state()
        await wheel('mouse', 120)
        const after = await state()
        assert.ok(after.grid > 0)
        assert.equal(after.cards[0].viewport, before.cards[0].viewport)
        assert.deepEqual(scrollInput(after.cards[1]), [])
      }
    )
    await suite.test('focus: Shift leaves a focused mouse-reporting TUI for the grid', async () => {
      await reset('focus')
      await page.evaluate(() => window.scrollHarness.focus('mouse'))
      await wheel('mouse', 120, true)
      const after = await state()
      assert.ok(after.grid > 0)
      assert.deepEqual(scrollInput(after.cards[1]), [])
    })
    for (const mode of ['terminal', 'grid']) {
      await suite.test(
        `${mode}: small physical notch keeps its report count through Shift replay`,
        async () => {
          await reset(mode)
          await page.evaluate((shiftKey) => {
            const screen = document.querySelector('#mouse .xterm-screen')
            const rect = screen.getBoundingClientRect()
            const event = new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: 12,
              shiftKey,
              clientX: rect.left + 50,
              clientY: rect.top + 30
            })
            Object.defineProperties(event, {
              wheelDeltaY: { value: -120 },
              wheelDelta: { value: -120 }
            })
            screen.dispatchEvent(event)
          }, mode === 'grid')
          const after = await state()
          const reports = after.cards
            .find((card) => card.kind === 'mouse')
            .data.filter((value) => value.startsWith('\x1b[<65;'))
          assert.equal(reports.length, 1)
          assert.equal(after.grid, 0)
        }
      )
    }
    for (const [deltaMode, deltaY, expected] of [
      [1, 3, 48],
      [2, 1, 720]
    ]) {
      await suite.test(
        `grid: native deltaMode ${deltaMode} is converted to pixel travel`,
        async () => {
          await reset('grid')
          await page.evaluate(
            ({ deltaMode, deltaY }) => {
              document.querySelector('#normal .xterm-screen').dispatchEvent(
                new WheelEvent('wheel', {
                  bubbles: true,
                  cancelable: true,
                  deltaMode,
                  deltaY
                })
              )
            },
            { deltaMode, deltaY }
          )
          assert.equal((await state()).grid, expected)
        }
      )
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
