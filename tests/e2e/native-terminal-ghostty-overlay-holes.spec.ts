import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  isNativeSurfaceHidden,
  nativeTerminalDebug,
  nativeScreenText,
  splitNativeTerminalPane,
  xtermScreenTransform
} from './helpers/native-terminal-debug'
import { execInTerminal, waitForActiveTerminalManager } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type Hole = { x: number; y: number; width: number; height: number; hit: string }
type OverlaySpec = { role: string; inPopper: boolean; width: number; height: number }

const OVERLAY_ID = 'native-terminal-e2e-hole-overlay'
const RENDER_COUNT_KEY = '__orcaE2eHoleXtermRenders'
const SAMPLE_MS = 1_500
const SAMPLE_EVERY_MS = 25

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

async function openNativePane(
  page: Page,
  app: ElectronApplication
): Promise<{ ptyId: string; surfaceId: number }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  // Why: the hidden test window would otherwise pause rAF, so xterm could never paint at all.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
  })
  // A one-time sidebar hint is itself a popper; start from a window with no overlays.
  await expect
    .poll(async () => page.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  await enableNativeTerminal(page)
  const pane = await splitNativeTerminalPane(page, app)
  await expect.poll(async () => xtermScreenTransform(page, pane.ptyId)).not.toBe('')
  return pane
}

async function surfaceHoles(app: ElectronApplication, surfaceId: number): Promise<Hole[]> {
  const state = await nativeTerminalDebug(app, 'state', [surfaceId])
  const holes: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'holes') : null
  if (!Array.isArray(holes)) {
    return []
  }
  return holes.map((hole: unknown) => ({
    x: Number(Reflect.get(Object(hole), 'x')),
    y: Number(Reflect.get(Object(hole), 'y')),
    width: Number(Reflect.get(Object(hole), 'width')),
    height: Number(Reflect.get(Object(hole), 'height')),
    hit: String(Reflect.get(Object(hole), 'hit'))
  }))
}

async function isMasked(app: ElectronApplication, surfaceId: number): Promise<boolean> {
  const state = await nativeTerminalDebug(app, 'state', [surfaceId])
  return typeof state === 'object' && state !== null && Reflect.get(state, 'masked') === true
}

// Places a DOM overlay inside the pane's terminal box, shaped like Orca's Radix poppers.
function showOverlay(
  page: Page,
  ptyId: string,
  spec: OverlaySpec
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  return page.evaluate(
    ({ id, overlayId, role, inPopper, width, height }) => {
      const box = document
        .querySelector(`.pane[data-pty-id="${id}"] .xterm-container`)
        ?.getBoundingClientRect()
      if (!box) {
        throw new Error(`no terminal box for PTY ${id}`)
      }
      const content = document.createElement('div')
      content.setAttribute('role', role)
      content.style.cssText = `width:${width}px;height:${height}px;background:#fff;box-shadow:rgba(0,0,0,0.1) 0px 10px 15px -3px`
      const left = Math.round(box.left + 40)
      const top = Math.round(box.top + 60)
      const root = document.createElement('div')
      root.id = overlayId
      root.style.cssText = `position:fixed;left:${left}px;top:${top}px;z-index:9999`
      if (inPopper) {
        root.setAttribute('data-radix-popper-content-wrapper', '')
        root.appendChild(content)
      } else {
        root.setAttribute('role', role)
        root.style.width = `${width}px`
        root.style.height = `${height}px`
        root.style.background = '#fff'
      }
      document.body.appendChild(root)
      return { left, top, right: left + width, bottom: top + height }
    },
    { id: ptyId, overlayId: OVERLAY_ID, ...spec }
  )
}

function removeOverlay(page: Page): Promise<void> {
  return page.evaluate((overlayId) => document.getElementById(overlayId)?.remove(), OVERLAY_ID)
}

function countXtermRenders(page: Page, ptyId: string): Promise<void> {
  return page.evaluate(
    ({ id, key }) => {
      const pane = [...(window.__paneManagers?.values() ?? [])]
        .flatMap((manager) => manager.getPanes())
        .find((candidate) => candidate.container.dataset.ptyId === id)
      if (!pane) {
        throw new Error(`no pane for PTY ${id}`)
      }
      Reflect.set(globalThis, key, 0)
      pane.terminal.onRender(() => {
        Reflect.set(globalThis, key, Number(Reflect.get(globalThis, key)) + 1)
      })
    },
    { id: ptyId, key: RENDER_COUNT_KEY }
  )
}

function xtermRenderCount(page: Page): Promise<number> {
  return page.evaluate((key) => Number(Reflect.get(globalThis, key)), RENDER_COUNT_KEY)
}

// How often the native view was found hidden while sampling: any hit is visible flicker.
async function sampleHidden(app: ElectronApplication, surfaceId: number): Promise<number> {
  let hidden = 0
  const deadline = Date.now() + SAMPLE_MS
  while (Date.now() < deadline) {
    if ((await isNativeSurfaceHidden(app, surfaceId)) === true) {
      hidden += 1
    }
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_EVERY_MS))
  }
  return hidden
}

test('a menu over the pane shows through a hole while the native view stays up and xterm stays paused', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const { ptyId, surfaceId } = await openNativePane(orcaPage, electronApp)
  await countXtermRenders(orcaPage, ptyId)
  // Output keeps changing the screen around and under the menu while it is open.
  await execInTerminal(
    orcaPage,
    ptyId,
    "for i in $(seq 1 30); do echo hole-line-$i; sleep 0.05; done; printf 'HOLE-%s\\n' DONE"
  )
  const menu = await showOverlay(orcaPage, ptyId, {
    role: 'menu',
    inPopper: true,
    width: 180,
    height: 120
  })

  await expect.poll(async () => (await surfaceHoles(electronApp, surfaceId)).length).toBe(1)
  const [hole] = await surfaceHoles(electronApp, surfaceId)
  // The hole covers the menu and its shadow, in window points (the e2e window is at zoom 1).
  expect(hole.x).toBeLessThanOrEqual(menu.left)
  expect(hole.y).toBeLessThanOrEqual(menu.top)
  expect(hole.x + hole.width).toBeGreaterThanOrEqual(menu.right)
  expect(hole.y + hole.height).toBeGreaterThanOrEqual(menu.bottom)
  expect(hole.width).toBeLessThan(180 + 60)
  // A click at the menu reaches the web contents, not the terminal view.
  expect(hole.hit).not.toBe('OrcaGhosttySurfaceView')
  expect(hole.hit).not.toBe('none')
  expect(await isMasked(electronApp, surfaceId)).toBe(true)

  const hiddenSamples = await sampleHidden(electronApp, surfaceId)
  const renders = await xtermRenderCount(orcaPage)
  testInfo.annotations.push({
    type: 'native-terminal-hole',
    description: `menu open ${SAMPLE_MS}ms: hidden samples=${hiddenSamples}, xterm renders=${renders}`
  })
  expect(hiddenSamples).toBe(0)
  expect(renders).toBe(0)
  expect(await xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId), { timeout: 10_000 })
    .toContain('HOLE-DONE')

  await removeOverlay(orcaPage)
  await expect.poll(async () => isMasked(electronApp, surfaceId)).toBe(false)
  expect(await surfaceHoles(electronApp, surfaceId)).toEqual([])
})

test('a dialog, or an overlay over most of the pane, still hides the native view', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const { ptyId, surfaceId } = await openNativePane(orcaPage, electronApp)
  await countXtermRenders(orcaPage, ptyId)

  // Modal dialogs dim the whole window, so even a small one hides the view.
  await showOverlay(orcaPage, ptyId, { role: 'dialog', inPopper: false, width: 180, height: 120 })
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  expect(await xtermRenderCount(orcaPage)).toBeGreaterThan(0)
  testInfo.annotations.push({
    type: 'native-terminal-hole',
    description: `small modal dialog: hidden, xterm renders=${await xtermRenderCount(orcaPage)}`
  })
  await removeOverlay(orcaPage)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)

  const box = await orcaPage
    .locator(`.pane[data-pty-id="${ptyId}"] .xterm-container`)
    .evaluate((element) => element.getBoundingClientRect().toJSON())
  await showOverlay(orcaPage, ptyId, {
    role: 'menu',
    inPopper: true,
    width: Math.round(Number(Reflect.get(box, 'width')) - 60),
    height: Math.round(Number(Reflect.get(box, 'height')) - 80)
  })
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  await removeOverlay(orcaPage)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
})
