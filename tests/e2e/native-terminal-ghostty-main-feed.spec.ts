import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  nativeGridSize,
  nativeScreenText,
  nativeTerminalDebug,
  splitNativeTerminalPane
} from './helpers/native-terminal-debug'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContentForPtyId } from './terminal-pty-readiness'

const WRITE_COUNT_KEY = '__orcaE2eNativeWrites'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

async function prepare(page: Page, app: ElectronApplication): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  // Counts renderer→main mirror writes; main's own feed sends none of them.
  await app.evaluate(({ ipcMain }, key) => {
    const counter = { writes: 0 }
    Reflect.set(globalThis, key, counter)
    ipcMain.on('nativeTerminal:write', () => {
      counter.writes += 1
    })
  }, WRITE_COUNT_KEY)
  await expect
    .poll(async () => page.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  await enableNativeTerminal(page)
}

function mirrorWrites(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    (_electron, key) => Number(Reflect.get(Object(Reflect.get(globalThis, key)), 'writes')),
    WRITE_COUNT_KEY
  )
}

async function setMainFeed(app: ElectronApplication, enabled: boolean): Promise<void> {
  await nativeTerminalDebug(app, 'mainFeed', [enabled])
}

function normalizeScreen(text: string): string {
  const rows = text.split('\n').map((row) => row.trimEnd())
  while (rows.length > 0 && rows.at(-1) === '') {
    rows.pop()
  }
  return rows.join('\n')
}

// The xterm model's visible rows, as the native view should show them.
function xtermScreen(page: Page, ptyId: string): Promise<string> {
  return page.evaluate((id) => {
    const pane = [...(window.__paneManagers?.values() ?? [])]
      .flatMap((manager) => manager.getPanes())
      .find((candidate) => candidate.container.dataset.ptyId === id)
    if (!pane) {
      return ''
    }
    const buffer = pane.terminal.buffer.active
    const rows: string[] = []
    for (let y = buffer.viewportY; y < buffer.viewportY + pane.terminal.rows; y += 1) {
      const line = buffer.getLine(y)
      const text = line?.translateToString(true) ?? ''
      // Ghostty's screen text joins soft-wrapped rows into one logical line.
      if (line?.isWrapped && rows.length > 0) {
        rows[rows.length - 1] += text
      } else {
        rows.push(text)
      }
    }
    return rows.join('\n')
  }, ptyId)
}

async function expectIdenticalScreens(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const native = normalizeScreen(await nativeScreenText(app, surfaceId))
        const xterm = normalizeScreen(await xtermScreen(page, ptyId))
        // Why whitespace-blind: the two disagree on which rows are soft-wrapped when a shell
        // wraps its own prompt, while every visible character must still match in order.
        const same = native.replace(/\s+/g, '') === xterm.replace(/\s+/g, '')
        return same ? 'identical' : `native:\n${native}\nxterm:\n${xterm}`
      },
      { timeout: 15_000 }
    )
    .toBe('identical')
}

test('main feeds the native view from the PTY stream: same screen as xterm, no mirror IPC', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage, electronApp)
  const before = await mirrorWrites(electronApp)
  const { ptyId, surfaceId } = await splitNativeTerminalPane(orcaPage, electronApp)
  await execInTerminal(orcaPage, ptyId, "seq 1 2000; printf 'MAIN-FEED-%s\\n' DONE")
  await waitForTerminalOutput(orcaPage, 'MAIN-FEED-DONE')
  await expectIdenticalScreens(orcaPage, electronApp, ptyId, surfaceId)
  expect(await mirrorWrites(electronApp)).toBe(before)

  // The renderer mirror stays the fallback where main does not feed a surface.
  await setMainFeed(electronApp, false)
  const mirrored = await splitNativeTerminalPane(orcaPage, electronApp)
  await execInTerminal(orcaPage, mirrored.ptyId, "printf 'MIRROR-%s\\n' OK")
  await waitForTerminalOutput(orcaPage, 'MIRROR-OK')
  await expectIdenticalScreens(orcaPage, electronApp, mirrored.ptyId, mirrored.surfaceId)
  expect(await mirrorWrites(electronApp)).toBeGreaterThan(before)
  await setMainFeed(electronApp, true)
})

test('a resize in the middle of a flood leaves the native view and xterm identical', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage, electronApp)
  const { ptyId, surfaceId } = await splitNativeTerminalPane(orcaPage, electronApp)
  const gridBefore = await nativeGridSize(electronApp, surfaceId)
  await execInTerminal(orcaPage, ptyId, "seq 1 200000; printf 'RESIZE-%s\\n' DONE")
  // Splitting the flooding pane halves its width while the output is still streaming.
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await expect
    .poll(async () => (await nativeGridSize(electronApp, surfaceId))?.columns ?? 0)
    .toBeLessThan(gridBefore?.columns ?? 0)
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId), { timeout: 60_000 })
    .toContain('RESIZE-DONE')
  // The split made the new pane active; read the flooding pane's own xterm.
  await expect
    .poll(async () => getTerminalContentForPtyId(orcaPage, ptyId, 4000), { timeout: 60_000 })
    .toContain('RESIZE-DONE')
  await expectIdenticalScreens(orcaPage, electronApp, ptyId, surfaceId)
})

test('a reload reattaches each native view to its PTY from main’s model', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage, electronApp)
  const { ptyId } = await splitNativeTerminalPane(orcaPage, electronApp)
  await execInTerminal(orcaPage, ptyId, "seq 1 300; printf 'BEFORE-%s\\n' RELOAD")
  await waitForTerminalOutput(orcaPage, 'BEFORE-RELOAD')

  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await expect
    .poll(async () => orcaPage.locator(`.pane[data-pty-id="${ptyId}"]`).count(), {
      timeout: 30_000
    })
    .toBe(1)
  const surfaceId = await findNativeSurfaceForPane(orcaPage, ptyId, 30_000)
  expect(surfaceId).not.toBeNull()
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId ?? 0), { timeout: 15_000 })
    .toContain('BEFORE-RELOAD')
  await expectIdenticalScreens(orcaPage, electronApp, ptyId, surfaceId ?? 0)
  // Live output keeps flowing to the reattached view.
  await execInTerminal(orcaPage, ptyId, "printf 'AFTER-%s\\n' RELOAD")
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId ?? 0))
    .toContain('AFTER-RELOAD')
})
