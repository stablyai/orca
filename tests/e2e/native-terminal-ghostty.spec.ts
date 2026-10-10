import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { openTerminalTabInActiveGroup } from './helpers/terminal-tab-open'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type NativeTerminalDebugOp =
  | 'surfaceIds'
  | 'state'
  | 'grid'
  | 'screenText'
  | 'snapshotBase64'
  | 'key'
  | 'scrollbar'
  | 'scrollbarScroll'

type NativeScrollbar = {
  total: number
  offset: number
  len: number
  visible: boolean
  knobProportion: number
  knobPosition: number
  hitScroller: string
  hitBeside: string
}

const RETURN_KEY_CODE = 0x24

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

// Main installs these hooks in unpackaged builds (installNativeTerminalDebugHooks).
function debugCall(
  app: ElectronApplication,
  op: NativeTerminalDebugOp,
  args: unknown[] = []
): Promise<unknown> {
  return app.evaluate(
    (_electron, [name, callArgs]) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const fn: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, name) : null
      if (typeof fn !== 'function') {
        throw new Error(`native terminal debug hook ${name} is not installed`)
      }
      return Reflect.apply(fn, debug, callArgs)
    },
    [op, args] as const
  )
}

async function surfaceIds(app: ElectronApplication): Promise<number[]> {
  const ids = await debugCall(app, 'surfaceIds')
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []
}

async function screenText(app: ElectronApplication, surfaceId: number): Promise<string> {
  const text = await debugCall(app, 'screenText', [surfaceId])
  return typeof text === 'string' ? text : ''
}

async function isHidden(app: ElectronApplication, surfaceId: number): Promise<boolean | null> {
  const state = await debugCall(app, 'state', [surfaceId])
  const hidden: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'hidden') : null
  return typeof hidden === 'boolean' ? hidden : null
}

async function nativeGrid(app: ElectronApplication, surfaceId: number): Promise<string | null> {
  const grid = await debugCall(app, 'grid', [surfaceId])
  if (typeof grid !== 'object' || grid === null) {
    return null
  }
  return `${Reflect.get(grid, 'columns')}x${Reflect.get(grid, 'rows')}`
}

async function nativeScrollbar(
  app: ElectronApplication,
  surfaceId: number
): Promise<NativeScrollbar | null> {
  const state = await debugCall(app, 'scrollbar', [surfaceId])
  if (typeof state !== 'object' || state === null) {
    return null
  }
  const numberAt = (key: string): number => Number(Reflect.get(state, key))
  const textAt = (key: string): string => String(Reflect.get(state, key))
  return {
    total: numberAt('total'),
    offset: numberAt('offset'),
    len: numberAt('len'),
    visible: Reflect.get(state, 'visible') === true,
    knobProportion: numberAt('knobProportion'),
    knobPosition: numberAt('knobPosition'),
    hitScroller: textAt('hitScroller'),
    hitBeside: textAt('hitBeside')
  }
}

// The renderer tags each pane's terminal box with the surface drawing it.
async function paneSurfaceId(page: Page, ptyId: string): Promise<number> {
  const id = await page
    .locator(`.pane[data-pty-id="${ptyId}"] .xterm-container`)
    .getAttribute('data-native-surface-id')
  return Number(id ?? 0)
}

async function paneXtermCols(page: Page, ptyId: string): Promise<number | null> {
  return page.evaluate((id) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes()) {
        if (pane.container.dataset.ptyId === id) {
          return pane.terminal.cols
        }
      }
    }
    return null
  }, ptyId)
}

async function activeXtermGrid(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    return pane ? { cols: pane.terminal.cols, rows: pane.terminal.rows } : null
  })
}

test('a new terminal draws through a native Ghostty surface that mirrors its PTY', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: true })
  })

  // A split binds a fresh PTY with the setting on.
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)

  let surfaceId = 0
  await expect
    .poll(
      async () => {
        surfaceId = (await surfaceIds(electronApp)).at(-1) ?? 0
        return surfaceId
      },
      { timeout: 15_000, message: 'no native terminal surface was created for the new pane' }
    )
    .toBeGreaterThan(0)

  // Output: PTY bytes that reach xterm also reach the native screen.
  await execInTerminal(orcaPage, ptyId, "printf 'NATIVE-%s\\n' OUT-OK")
  await waitForTerminalOutput(orcaPage, 'NATIVE-OUT-OK')
  await expect
    .poll(async () => screenText(electronApp, surfaceId), { timeout: 10_000 })
    .toContain('NATIVE-OUT-OK')

  // Input: keys typed into the native view are encoded by Ghostty, take the pane's PTY input
  // path, and the echo comes back to both screens.
  for (const character of "printf 'NATIVE-%s\\n' IN-OK") {
    await debugCall(electronApp, 'key', [surfaceId, character, 0, 0])
  }
  await debugCall(electronApp, 'key', [surfaceId, '\r', RETURN_KEY_CODE, 0])
  await waitForTerminalOutput(orcaPage, 'NATIVE-IN-OK')
  await expect.poll(async () => screenText(electronApp, surfaceId)).toContain('NATIVE-IN-OK')

  // Grid: the hidden xterm (and so the PTY) follows Ghostty's cell grid.
  await expect
    .poll(async () => {
      const native = await nativeGrid(electronApp, surfaceId)
      const xterm = await activeXtermGrid(orcaPage)
      return native && xterm ? `${xterm.cols}x${xterm.rows}=${native}` : null
    })
    .toMatch(/^(\d+)x(\d+)=\1x\2$/)
  // The grid must fill the pane, not collapse through the xterm/native resize loop.
  const rows = Number((await nativeGrid(electronApp, surfaceId))?.split('x')[1])
  expect(rows).toBeGreaterThan(5)

  // Placement: the view is visible and covers the pane's terminal box (inside its padding).
  await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(false)
  await expect
    .poll(async () => {
      const state = await debugCall(electronApp, 'state', [surfaceId])
      const rect = await orcaPage
        .locator(`.pane[data-pty-id="${ptyId}"] .xterm-container`)
        .evaluate((element) => {
          const box = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const left = Number.parseFloat(style.paddingLeft) || 0
          const top = Number.parseFloat(style.paddingTop) || 0
          const width = box.width - left - (Number.parseFloat(style.paddingRight) || 0)
          const height = box.height - top - (Number.parseFloat(style.paddingBottom) || 0)
          // The view may start lower to keep pane chrome (title bar, actions) clickable.
          return [box.left + left, width, box.top + top + height].map(Math.round).join(',')
        })
      if (typeof state !== 'object' || state === null) {
        return null
      }
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) =>
        Number(Reflect.get(state, key))
      )
      const frame = [x, width, y + height].map(Math.round).join(',')
      return frame === rect ? 'aligned' : `${frame} vs ${rect}`
    })
    .toBe('aligned')

  // Overlays: DOM UI over the pane hides the native view so it can render on top.
  await orcaPage.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'native-terminal-e2e-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
    document.body.appendChild(overlay)
  })
  await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(true)
  await orcaPage.evaluate(() => document.getElementById('native-terminal-e2e-overlay')?.remove())
  await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(false)

  // Let the re-shown surface present a fresh frame before capturing it.
  await orcaPage.waitForTimeout(500)
  // Same screen through both renderers, for review: the web terminal (DOM) and Ghostty (native).
  const xtermShot = testInfo.outputPath('xterm-terminal.png')
  await orcaPage.locator(`.pane[data-pty-id="${ptyId}"] .xterm`).screenshot({ path: xtermShot })
  await testInfo.attach('xterm-terminal', { path: xtermShot, contentType: 'image/png' })

  const png = await debugCall(electronApp, 'snapshotBase64', [surfaceId])
  if (typeof png === 'string') {
    const file = testInfo.outputPath('native-terminal.png')
    writeFileSync(file, Buffer.from(png, 'base64'))
    await testInfo.attach('native-terminal', { path: file, contentType: 'image/png' })
  }
})

test('a native surface with scrollback shows an overlay scrollbar that scrolls Ghostty', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  // The first pane binds before the setting flips, so only the split gets a native surface.
  await waitForPtyShellEcho(orcaPage, await waitForActivePanePtyId(orcaPage), 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: true })
  })
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
  let surfaceId = 0
  await expect
    .poll(async () => {
      for (const id of await surfaceIds(electronApp)) {
        if ((await isHidden(electronApp, id)) === false) {
          surfaceId = id
        }
      }
      return surfaceId
    })
    .toBeGreaterThan(0)

  // Everything fits: no scroller, and the right edge stays the terminal's.
  await expect
    .poll(async () => {
      const bar = await nativeScrollbar(electronApp, surfaceId)
      return bar ? `${bar.visible} ${bar.total <= bar.len} ${bar.hitScroller}` : null
    })
    .toBe('false true OrcaGhosttySurfaceView')

  await execInTerminal(orcaPage, ptyId, 'for i in $(seq 1 300); do echo NATIVE-ROW-$i; done')
  await waitForTerminalOutput(orcaPage, 'NATIVE-ROW-300')
  await expect
    .poll(async () => screenText(electronApp, surfaceId), { timeout: 10_000 })
    .toContain('NATIVE-ROW-300')

  // Scrollback: a visible knob sized len/total, pinned to the bottom, that takes clicks.
  await expect
    .poll(async () => {
      const bar = await nativeScrollbar(electronApp, surfaceId)
      return (
        bar !== null && bar.visible && bar.total > bar.len && bar.offset + bar.len === bar.total
      )
    })
    .toBe(true)
  const bottom = await nativeScrollbar(electronApp, surfaceId)
  expect(bottom?.knobProportion).toBeCloseTo((bottom?.len ?? 0) / (bottom?.total ?? 1), 2)
  expect(bottom?.knobPosition).toBeCloseTo(1, 2)
  expect(bottom?.hitScroller).toContain('Scroller')
  expect(bottom?.hitBeside).toBe('OrcaGhosttySurfaceView')
  const bottomText = await screenText(electronApp, surfaceId)

  // Dragging the knob to the top scrolls Ghostty's viewport to the first row.
  expect(await debugCall(electronApp, 'scrollbarScroll', [surfaceId, 0])).toBe(true)
  await expect.poll(async () => (await nativeScrollbar(electronApp, surfaceId))?.offset).toBe(0)
  await expect.poll(async () => screenText(electronApp, surfaceId)).not.toContain('NATIVE-ROW-300')
  expect(await screenText(electronApp, surfaceId)).not.toBe(bottomText)
  expect((await nativeScrollbar(electronApp, surfaceId))?.knobPosition).toBeCloseTo(0, 2)

  // Halfway lands on the middle row.
  await debugCall(electronApp, 'scrollbarScroll', [surfaceId, 0.5])
  await expect
    .poll(async () => {
      const bar = await nativeScrollbar(electronApp, surfaceId)
      return bar ? Math.abs(bar.offset - Math.round((bar.total - bar.len) / 2)) : null
    })
    .toBeLessThanOrEqual(1)

  await debugCall(electronApp, 'scrollbarScroll', [surfaceId, 1])
  await expect
    .poll(async () => {
      const bar = await nativeScrollbar(electronApp, surfaceId)
      return bar ? bar.total - bar.offset - bar.len : null
    })
    .toBe(0)
  await expect.poll(async () => screenText(electronApp, surfaceId)).toContain('NATIVE-ROW-300')
})

test('panes that bind after the setting turns on each draw through their own seeded surface', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  // The startup pane binds before the setting, so it never gets a surface; a fresh tab's panes
  // bind after it. The covering dialog keeps their surfaces unplaced while they attach.
  const startupPty = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, startupPty, 30_000)
  await orcaPage.evaluate(async () => {
    const overlay = document.createElement('div')
    overlay.id = 'native-terminal-e2e-cover'
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
    document.body.appendChild(overlay)
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: true })
  })
  await openTerminalTabInActiveGroup(orcaPage)
  let firstPty = ''
  await expect
    .poll(async () => {
      firstPty = await waitForActivePanePtyId(orcaPage)
      return firstPty
    })
    .not.toBe(startupPty)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPtyShellEcho(orcaPage, firstPty, 30_000)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const secondPty = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, secondPty, 30_000)
  const panes = [firstPty, secondPty]

  // Every surface belongs to exactly one pane: none is left over, none shared.
  await expect
    .poll(async () => {
      const owned = await Promise.all(panes.map((ptyId) => paneSurfaceId(orcaPage, ptyId)))
      const all = (await surfaceIds(electronApp)).toSorted((a, b) => a - b)
      return `${owned.toSorted((a, b) => a - b).join(',')} = ${all.join(',')}`
    })
    .toMatch(/^(\d+,\d+) = \1$/)
  const surfaces = await Promise.all(panes.map((ptyId) => paneSurfaceId(orcaPage, ptyId)))
  expect(new Set(surfaces).size).toBe(2)

  // An unplaced surface must not size the PTY from Ghostty's 1x1 placeholder grid.
  for (const surfaceId of surfaces) {
    expect(await isHidden(electronApp, surfaceId)).toBe(true)
  }
  for (const ptyId of panes) {
    expect(await paneXtermCols(orcaPage, ptyId)).toBeGreaterThan(20)
  }
  await orcaPage.evaluate(() => document.getElementById('native-terminal-e2e-cover')?.remove())
  // The one-time sidebar hint tooltip can still cover the left pane for a few seconds.
  await expect(orcaPage.getByRole('tooltip')).toHaveCount(0, { timeout: 20_000 })
  for (const surfaceId of surfaces) {
    await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(false)
  }

  // Each surface was seeded and mirrors its own pane, not its neighbour.
  for (const [index, ptyId] of panes.entries()) {
    await execInTerminal(orcaPage, ptyId, `printf 'NATIVE-PANE-%s\\n' ${index}`)
  }
  for (const [index, surfaceId] of surfaces.entries()) {
    await expect
      .poll(async () => {
        const text = await screenText(electronApp, surfaceId)
        return text.includes(`NATIVE-PANE-${index}`) && !text.includes(`NATIVE-PANE-${1 - index}`)
      })
      .toBe(true)
  }
  await expect
    .poll(async () => {
      const native = await nativeGrid(electronApp, surfaces[1])
      const xterm = await paneXtermCols(orcaPage, secondPty)
      return native?.split('x')[0] === String(xterm)
    })
    .toBe(true)
})
