import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const FIXTURE_ROWS = 400
const MINIMUM_PIN_DISTANCE_ROWS = 150

type VisibleViewport = {
  viewportY: number
  baseY: number
  rows: number
  topRow: string
  visibleText: string
}

function scrollbackFixtureScript(runId: string): string {
  return `
async function writeStdout(chunk) {
  await new Promise((resolve) => process.stdout.write(chunk, resolve))
  if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 8))
}
await writeStdout('\\x1b[2J\\x1b[H')
let batch = ''
for (let index = 0; index < ${FIXTURE_ROWS}; index += 1) {
  batch += 'SCROLL_PIN_${runId}_ROW_' + String(index).padStart(5, '0') + '\\r\\n'
  if (batch.length > 4000) {
    await writeStdout(batch)
    batch = ''
  }
}
await writeStdout(batch)
await writeStdout('SCROLL_PIN_${runId}_DONE\\r\\n')
`
}

async function closeFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    if (store?.getState().activeModal === 'feature-tips') {
      store.getState().closeModal()
    }
  })
}

/** Read exactly the rows the user can see in the terminal pane right now. */
async function readVisibleTerminalViewport(page: Page, tabId?: string): Promise<VisibleViewport> {
  const reading = await readVisibleTerminalViewportIfMounted(page, tabId)
  if (!reading) {
    throw new Error('Active terminal pane unavailable')
  }
  return reading
}

/** Same reading, but null while the pane is between mounts (safe inside a poll). */
async function readVisibleTerminalViewportIfMounted(
  page: Page,
  tabId?: string
): Promise<VisibleViewport | null> {
  return page.evaluate((explicitTabId) => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      explicitTabId ??
      (state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null)
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    const buffer = pane.terminal.buffer.active
    const visibleLines = Array.from(
      { length: pane.terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    )
    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      rows: pane.terminal.rows,
      topRow: visibleLines.find((line) => line.trim().length > 0) ?? '',
      visibleText: visibleLines.join('\n')
    }
  }, tabId)
}

/** Scroll the real terminal viewport up with Shift+PageUp until the prompt is off screen. */
async function scrollTerminalBackUntilPinned(page: Page): Promise<VisibleViewport> {
  await focusActiveTerminalInput(page)
  for (let press = 0; press < 12; press += 1) {
    const reading = await readVisibleTerminalViewport(page)
    if (reading.baseY - reading.viewportY >= MINIMUM_PIN_DISTANCE_ROWS) {
      return reading
    }
    await page.keyboard.press('Shift+PageUp')
    await page.waitForTimeout(120)
  }
  return readVisibleTerminalViewport(page)
}

/**
 * Emulate the failure precondition the fix names: while the worktree surface is
 * `display:none`, xterm's viewport can collapse to line 0 while `baseY` is
 * unchanged (its scroll dimensions clamp to a zero-height surface). Chromium on
 * macOS keeps the JS-managed scroll position across a hidden surface, so the
 * collapse is driven here through xterm's own scroll API on the hidden pane.
 */
async function collapseHiddenTerminalViewport(page: Page, tabId: string): Promise<VisibleViewport> {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Hidden terminal pane unavailable')
    }
    pane.terminal.scrollToLine(0)
  }, tabId)
  return readVisibleTerminalViewport(page, tabId)
}

test.describe('Terminal hidden viewport collapse scroll restore', () => {
  test('restores the pinned terminal scrollback rows when returning to a worktree whose hidden viewport collapsed', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'scroll restore repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const terminalTabId = await orcaPage.evaluate(
      () => window.__store?.getState().activeTabId ?? null
    )
    expect(terminalTabId).toBeTruthy()
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-hidden-collapse-scroll-${runId}.mjs`)
    writeFileSync(scriptPath, scrollbackFixtureScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 20_000,
          message: 'scrollback fixture never reached the terminal'
        })
        .toContain(`SCROLL_PIN_${runId}_DONE`)

      const pinned = await scrollTerminalBackUntilPinned(orcaPage)
      expect(pinned.baseY - pinned.viewportY).toBeGreaterThanOrEqual(MINIMUM_PIN_DISTANCE_ROWS)
      // The user is parked mid-scrollback: neither the first row of scrollback
      // nor the shell prompt at the bottom is on screen.
      expect(pinned.visibleText).toContain(`SCROLL_PIN_${runId}_ROW_`)
      expect(pinned.visibleText).not.toContain(`SCROLL_PIN_${runId}_ROW_00000`)
      expect(pinned.visibleText).not.toContain(`SCROLL_PIN_${runId}_DONE`)
      const pinnedTopRow = pinned.topRow

      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const collapsed = await collapseHiddenTerminalViewport(orcaPage, terminalTabId!)
      expect(collapsed.viewportY).toBe(0)
      expect(collapsed.baseY).toBe(pinned.baseY)

      await switchToWorktree(orcaPage, firstWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)

      // Regression (#8715): the revealed pane must show the rows the user left
      // on screen, not the top of the scrollback.
      await expect
        .poll(
          async () =>
            (await readVisibleTerminalViewportIfMounted(orcaPage, terminalTabId!))?.topRow ?? null,
          {
            timeout: 15_000,
            message: 'returning to the worktree did not restore the pinned scrollback rows'
          }
        )
        .toBe(pinnedTopRow)

      const restored = await readVisibleTerminalViewport(orcaPage, terminalTabId!)
      testInfo.annotations.push({
        type: 'terminal-scroll-restore',
        description: JSON.stringify({
          pinnedViewportY: pinned.viewportY,
          pinnedTopRow,
          restoredViewportY: restored.viewportY,
          restoredTopRow: restored.topRow
        })
      })
      expect(restored.visibleText).not.toContain(`SCROLL_PIN_${runId}_ROW_00000`)
      expect(restored.visibleText).toBe(pinned.visibleText)
      expect(restored.viewportY).toBe(pinned.viewportY)

      const screenshotPath = testInfo.outputPath('terminal-scroll-restored-after-return.png')
      await orcaPage.screenshot({ path: screenshotPath })
      await testInfo.attach('terminal-scroll-restored-after-return.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
