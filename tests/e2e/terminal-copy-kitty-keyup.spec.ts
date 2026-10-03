import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/terminal-kitty-release-fixture.cjs'
)

declare global {
  // Main-process clipboard probe for this spec.
  var __kittyCopyWrites: string[] | undefined
}

// Substitute only the terminal clipboard write; never overwrite the user's system clipboard.
async function captureTerminalClipboard(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const writes: string[] = []
    globalThis.__kittyCopyWrites = writes
    ipcMain.removeHandler('clipboard:writeTerminalText')
    ipcMain.handle('clipboard:writeTerminalText', (_event, text: string) => {
      writes.push(text)
    })
  })
}

function readTerminalClipboardWrites(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => globalThis.__kittyCopyWrites ?? [])
}

/** Scrolls to `scrollTo`, then selects the rows whose text is exactly `firstText` through `lastText`. */
async function scrollAndSelectRows(
  page: Page,
  scrollTo: number,
  firstText: string,
  lastText: string
): Promise<void> {
  await page.evaluate(
    ({ scrollTo, firstText, lastText }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error('Active terminal pane unavailable')
      }
      pane.terminal.scrollToLine(scrollTo)
      const buffer = pane.terminal.buffer.active
      let first = -1
      let last = -1
      for (let y = 0; y < buffer.length; y++) {
        const text = (buffer.getLine(y)?.translateToString(true) ?? '').trim()
        if (first === -1 && text === firstText) {
          first = y
        }
        if (first !== -1 && text === lastText) {
          last = y
          break
        }
      }
      if (first === -1 || last === -1) {
        throw new Error('Fixture rows not found')
      }
      pane.terminal.selectLines(first, last)
    },
    { scrollTo, firstText, lastText }
  )
}

// Must match the fixture's PROBE; the fixture keeps it out of the leak log.
const PROBE = '\x1b]orca-kitty-probe\x1b\\'

/** Sends PROBE through xterm's input path, behind any keyup bytes xterm already emitted. */
async function sendProbeBehindTerminalInput(page: Page): Promise<void> {
  await page.evaluate((probe) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    // Why false: not user input, so it cannot trigger scrollOnUserInput itself.
    pane.terminal.input(probe, false)
  }, PROBE)
}

function readViewport(page: Page): Promise<{ viewportY: number; baseY: number }> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return { viewportY: buffer.viewportY, baseY: buffer.baseY }
  })
}

test.describe('terminal copy under kitty release reporting (#17606)', () => {
  test.beforeEach(async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await captureTerminalClipboard(electronApp)
  })

  test('copying a scrollback selection keeps the viewport when the modifier is released first', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const inputLogPath = testInfo.outputPath('kitty-input.log')
    const probeAckPath = testInfo.outputPath('kitty-probe.ack')
    await execInTerminal(
      orcaPage,
      ptyId,
      `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(inputLogPath)} ${JSON.stringify(probeAckPath)}`
    )
    await waitForTerminalOutput(orcaPage, 'KITTY_RELEASE_FIXTURE_READY')
    try {
      await scrollAndSelectRows(orcaPage, 20, 'scrollback line 25', 'scrollback line 26')
      await focusActiveTerminalInput(orcaPage)
      const before = await readViewport(orcaPage)
      expect(before.viewportY).toBeLessThan(before.baseY)
      await orcaPage.screenshot({ path: testInfo.outputPath('before-copy.png') })

      // Why this order: the leak needs the modifier released before C, which is
      // also the only order in which macOS delivers C's keyup at all.
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await orcaPage.keyboard.down(modifier)
      await orcaPage.keyboard.down('c')
      await orcaPage.keyboard.up(modifier)
      await orcaPage.keyboard.up('c')
      await expect
        .poll(() => readTerminalClipboardWrites(electronApp))
        .toEqual([
          `scrollback line 25${process.platform === 'win32' ? '\r\n' : '\n'}scrollback line 26`
        ])
      // Why a probe, not a sleep: once the fixture acks it, any leaked keyup
      // bytes queued ahead of it are already in the input log.
      await sendProbeBehindTerminalInput(orcaPage)
      await expect.poll(() => existsSync(probeAckPath)).toBe(true)

      const after = await readViewport(orcaPage)
      const received = existsSync(inputLogPath) ? readFileSync(inputLogPath, 'utf8') : ''
      await orcaPage.screenshot({ path: testInfo.outputPath('after-copy.png') })
      writeFileSync(
        testInfo.outputPath('viewport.json'),
        JSON.stringify({ before, after, received }, null, 2)
      )
      expect(after.viewportY).toBe(before.viewportY)
      expect(received).toBe('')
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
})
