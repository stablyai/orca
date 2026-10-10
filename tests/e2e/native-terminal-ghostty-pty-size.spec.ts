/**
 * Native panes in a window that is never shown (the E2E window, a background launch): the PTY
 * gets a sane grid from xterm's fit until Ghostty has one for a placed view, Ghostty then takes
 * over in one resize, and a near-zero pane box never shrinks the PTY.
 */
import { readFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { openTerminalTabInActiveGroup } from './helpers/terminal-tab-open'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  settledNativeGrid,
  splitNativeTerminalPane
} from './helpers/native-terminal-debug'

type Grid = { cols: number; rows: number }

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

function ptySize(page: Page, ptyId: string): Promise<Grid | null> {
  return page.evaluate((id) => window.api.pty.getSize(id), ptyId)
}

function xtermSize(page: Page, ptyId: string): Promise<Grid | null> {
  return page.evaluate((id) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes()) {
        if (pane.container.dataset.ptyId === id) {
          return { cols: pane.terminal.cols, rows: pane.terminal.rows }
        }
      }
    }
    return null
  }, ptyId)
}

// Each SIGWINCH the shell sees appends the size it reads to this file.
async function trapWinch(page: Page, ptyId: string, file: string): Promise<() => string[]> {
  await execInTerminal(page, ptyId, `trap 'stty size >> "${file}"' WINCH; echo WINCH-TRAP-READY`)
  await waitForTerminalOutput(page, 'WINCH-TRAP-READY', 10_000)
  return () => {
    try {
      return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
}

async function startOnXtermPane(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  // The startup pane binds before the setting, so it stays an xterm pane.
  await waitForPtyShellEcho(page, await waitForActivePanePtyId(page), 30_000)
}

test('an unplaced native pane takes xterm’s fit, then Ghostty’s grid in one resize', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await startOnXtermPane(orcaPage)
  const startupPty = await waitForActivePanePtyId(orcaPage)
  // The covering dialog keeps the new pane's surface hidden, so it is never placed.
  await orcaPage.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'native-pty-size-cover'
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
    document.body.appendChild(overlay)
  })
  await enableNativeTerminal(orcaPage)
  await openTerminalTabInActiveGroup(orcaPage)
  let ptyId = startupPty
  await expect
    .poll(async () => (ptyId = await waitForActivePanePtyId(orcaPage)))
    .not.toBe(startupPty)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)

  // Within a second of the first prompt the PTY has xterm's own fit, not a placeholder grid.
  await expect
    .poll(
      async () => {
        const [pty, xterm] = [await ptySize(orcaPage, ptyId), await xtermSize(orcaPage, ptyId)]
        return (
          pty !== null &&
          pty.cols > 20 &&
          pty.rows > 4 &&
          JSON.stringify(pty) === JSON.stringify(xterm)
        )
      },
      { timeout: 1000, intervals: [50] }
    )
    .toBe(true)
  const surfaceId = await findNativeSurfaceForPane(orcaPage, ptyId)
  expect(surfaceId).not.toBeNull()
  if (surfaceId === null) {
    return
  }
  expect(await isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)

  // Placing the view hands the PTY to Ghostty's grid with one SIGWINCH at most.
  const winches = await trapWinch(orcaPage, ptyId, testInfo.outputPath('winch-takeover.log'))
  await orcaPage.evaluate(() => document.getElementById('native-pty-size-cover')?.remove())
  await expect(orcaPage.getByRole('tooltip')).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
  const grid = await settledNativeGrid(electronApp, surfaceId)
  await expect
    .poll(async () => ptySize(orcaPage, ptyId))
    .toEqual({ cols: grid.columns, rows: grid.rows })
  await orcaPage.waitForTimeout(500)
  expect(winches().length).toBeLessThanOrEqual(1)
})

test('a near-zero pane box never shrinks a native pane’s PTY', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await startOnXtermPane(orcaPage)
  await enableNativeTerminal(orcaPage)
  const { ptyId, surfaceId } = await splitNativeTerminalPane(orcaPage, electronApp)
  const grid = await settledNativeGrid(electronApp, surfaceId)
  const sane = { cols: grid.columns, rows: grid.rows }
  await expect.poll(async () => ptySize(orcaPage, ptyId)).toEqual(sane)
  const winches = await trapWinch(orcaPage, ptyId, testInfo.outputPath('winch-squeeze.log'))

  // As a worktree switch's transient overlay does: the pane's terminal box collapses briefly.
  const squeeze = (on: boolean): Promise<void> =>
    orcaPage.evaluate(
      ({ id, on }) => {
        const box = document.querySelector<HTMLElement>(
          `.pane[data-pty-id="${id}"] [data-native-surface-id]`
        )
        box?.style.setProperty('max-width', on ? '30px' : '')
        box?.style.setProperty('max-height', on ? '14px' : '')
      },
      { id: ptyId, on }
    )
  await squeeze(true)
  await orcaPage.waitForTimeout(500)
  expect(await ptySize(orcaPage, ptyId)).toEqual(sane)
  // Too small to fit, the box is not drawn natively either, so Ghostty never reflows into it.
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  await squeeze(false)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
  await orcaPage.waitForTimeout(500)
  expect(await ptySize(orcaPage, ptyId)).toEqual(sane)
  expect(winches()).toEqual([])
})
