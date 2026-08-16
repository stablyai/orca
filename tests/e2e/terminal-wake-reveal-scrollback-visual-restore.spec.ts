/**
 * E2E visual regression for #12047: a freshly-mounted terminal pane's
 * restored scrollback replays asynchronously (see
 * `restoreScrollbackBuffers` in `layout-serialization.ts`), but the
 * mount-time visibility effect's WebGL reveal repaint fires once, before
 * that replay settles. A worktree wake exercises the same fresh-mount +
 * scrollback-restore path as a mobile client's first reveal of a
 * cold/background-mounted tab, so it's the fastest single-launch repro.
 */

import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

async function sleepWorktreeTerminals(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    const state = store.getState()
    await state.shutdownWorktreeBrowsers(id)
    await state.shutdownWorktreeTerminals(id, { keepIdentifiers: true })
  }, worktreeId)
}

async function readLivePtyCountForWorktree(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return 0
    }
    const state = store.getState()
    const tabs = state.tabsByWorktree[id] ?? []
    return tabs.reduce((count, tab) => count + (state.ptyIdsByTabId[tab.id]?.length ?? 0), 0)
  }, worktreeId)
}

// Why: a large, densely colored full-screen grid makes stale WebGL glyph
// atlas cells (from #12047) visually obvious as ghost rectangles instead of
// a subtle one-cell diff a screenshot review could miss.
function denseColoredFrame(runId: string): string {
  const shortId = runId.slice(0, 8)
  const bgCodes = [41, 42, 43, 44, 45, 46, 100, 101]
  const rows: string[] = ['\x1b[2J\x1b[H']
  for (let row = 0; row < 40; row++) {
    const bg = bgCodes[row % bgCodes.length]
    const label = `OpenCode visual restore ${shortId} row ${String(row).padStart(2, '0')}`
    rows.push(`\x1b[${bg}m\x1b[97m${label.padEnd(78, ' ')}\x1b[0m`)
  }
  rows.push(`WAKE_REVEAL_RESTORE_${runId}`)
  return rows.join('\r\n')
}

function writeFrameScript(scriptPath: string, payload: string): void {
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64')
  writeFileSync(
    scriptPath,
    `process.stdout.write(Buffer.from(${JSON.stringify(encodedPayload)}, 'base64').toString('utf8'))\n`,
    'utf8'
  )
}

async function attachTerminalScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(name)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('Terminal wake reveal scrollback visual restore', () => {
  test('freshly-mounted pane repaints cleanly after wake-reveal scrollback replay', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'wake reveal visual restore needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const restoreMarker = `WAKE_REVEAL_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-wake-reveal-visual-${runId}.mjs`)
    writeFrameScript(scriptPath, denseColoredFrame(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      await waitForTerminalOutput(orcaPage, restoreMarker, 10_000, 20_000)

      await switchToWorktree(orcaPage, firstWorktreeId)
      await sleepWorktreeTerminals(orcaPage, secondWorktreeId)
      await expect
        .poll(() => readLivePtyCountForWorktree(orcaPage, secondWorktreeId), {
          timeout: 10_000,
          message: 'sleep did not release live PTYs for the background worktree'
        })
        .toBe(0)

      // Why: switch back and screenshot immediately (no extra settle wait) to
      // catch the fresh-mount reveal-repaint race described in #12047 —
      // waiting for the terminal content to settle would mask the timing bug.
      await switchToWorktree(orcaPage, secondWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await attachTerminalScreenshot(orcaPage, testInfo, 'wake-reveal-immediate.png')

      // Why: a second screenshot once things settle documents the same pane
      // isn't just slow to paint — it should look identical to the immediate
      // one once the fix's follow-up repaint has actually run.
      await waitForTerminalOutput(orcaPage, restoreMarker, 15_000, 20_000)
      await attachTerminalScreenshot(orcaPage, testInfo, 'wake-reveal-settled.png')
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
