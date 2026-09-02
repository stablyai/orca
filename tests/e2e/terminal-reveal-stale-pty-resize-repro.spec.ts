/**
 * Repro: stale PTY resize after worktree reveal (issues #7951 / #7240 family).
 *
 * Symptom (field reports + internal, v1.4.136): returning to a worktree
 * garbles the bottom of an idle TUI (Claude Code) until a manual window
 * resize.
 *
 * Mechanism: on reveal, noteVisibilityResume() requests a PTY size readback
 * that captures xterm's pre-reveal grid as the resize target
 * (pty-size-reassertion.ts). The reveal fit then refits xterm and resizes the
 * PTY while that read is in flight, with no follow-up request queued.
 * Instrumented traces show this stale-capture interleaving on EVERY reveal;
 * correctness then hinges solely on the applied-size read being processed
 * before the fit's resize (local FIFO luck). When the read loses that race —
 * busy daemon serializing reveal snapshots, SSH/relay round-trips — the
 * resolved callback sees applied != captured target and "repairs" the PTY
 * back to the pre-reveal grid. An idle TUI redraws for the wrong grid and
 * nothing heals it: no output means no grid-drift check, and no later layout
 * change means no ResizeObserver request.
 *
 * Test 1 drives the choreography with the natural read ordering (documents
 * the FIFO-lucky path). Test 2 delays the readback dispatch (e2e seam in
 * pty-applied-size-read-e2e-delay.ts) to model the losing ordering — on an
 * unpatched build the stale forward fires live (verified via instrumented
 * traces: FORWARD of the pre-reveal grid over the freshly fitted one). On
 * fast idle machines a follow-up reassertion heals it within tens of ms, so
 * the deterministic regression guard for the stale forward itself lives in
 * pty-size-reassertion.test.ts; this spec catches the persistent-desync
 * variant and keeps the full reveal path exercised under the field ordering.
 */

import type { Page, TestInfo } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type StaleResizeReproWindow = Window & {
  __paneManagers?: Map<
    string,
    {
      getPanes?: () => {
        container?: { dataset?: { ptyId?: string } }
        terminal?: { cols?: number; rows?: number }
      }[]
    }
  >
  __e2ePtyAppliedSizeReadDelayMs?: number
}

type GridSnapshot = {
  xterm: { cols: number; rows: number } | null
  applied: { cols: number; rows: number } | null
}

type CycleFailure = {
  cycle: number
  snapshot: GridSnapshot
}

const CONVERGE_TIMEOUT_MS = 6_000
// Why: sweep the applied-size read delay across the gap between the reveal
// fit's PTY resize landing in the daemon and the ResizeObserver follow-up
// request — the window where the stale forward fires. Fast idle machines
// rescue within ~30-50ms; the field (SSH/relay, loaded frames) may never.
const GETSIZE_DELAY_SWEEP_MS = [15, 20, 25, 30, 40, 60]
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 940, height: 640 },
  { width: 1120, height: 760 }
]

function bottomBarTuiScript(runId: string): string {
  // Why: redraw ONLY on SIGWINCH, like an idle Claude Code session. Periodic
  // output would trigger the foreground grid-drift check, which heals the
  // desync and masks the bug the field reports hit while idle.
  //
  // The bar is illustrative, NOT the assertion target: this spec asserts on
  // pty:getSize converging to xterm's grid. Do not assert on the bar's printed
  // cols — Node's `process.stdout.on('resize')` is unreliable under Windows
  // ConPTY (no SIGWINCH; a long-lived process can miss the notification while
  // the OS PTY is in fact resized), so a bar-content check flakes there even
  // though delivery succeeded (confirmed via base-vs-fix A/B + fresh-process
  // console read on Windows).
  return [
    'const draw = () => {',
    '  const rows = process.stdout.rows || 24',
    '  const cols = process.stdout.columns || 80',
    `  const bar = 'BOTTOM_BAR_${runId} rows=' + rows + ' cols=' + cols + ' ' + '='.repeat(200)`,
    "  process.stdout.write('\\x1b7\\x1b[' + rows + ';1H\\x1b[2K' + bar.slice(0, Math.max(1, cols - 1)) + '\\x1b8')",
    '}',
    "process.stdout.on('resize', draw)",
    'draw()',
    'setTimeout(() => process.exit(0), 600000)'
  ].join('\n')
}

async function readGridSnapshot(page: Page, ptyId: string): Promise<GridSnapshot> {
  return page.evaluate(async (ptyId) => {
    const win = window as StaleResizeReproWindow
    let xterm: { cols: number; rows: number } | null = null
    for (const manager of win.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        if (pane.container?.dataset?.ptyId === ptyId) {
          xterm = { cols: pane.terminal?.cols ?? 0, rows: pane.terminal?.rows ?? 0 }
        }
      }
    }
    // Why: the delay seam only affects the product's own readback wiring in
    // pty-connection, so probing window.api.pty.getSize directly stays fast.
    const applied = (await window.api?.pty?.getSize?.(ptyId)) ?? null
    return { xterm, applied }
  }, ptyId)
}

async function closeRightSidebarAndFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }
    store.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    if (store.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
}

function gridsConverged(snapshot: GridSnapshot): boolean {
  return (
    snapshot.xterm !== null &&
    snapshot.applied !== null &&
    snapshot.xterm.cols > 0 &&
    snapshot.xterm.rows > 0 &&
    snapshot.applied.cols === snapshot.xterm.cols &&
    snapshot.applied.rows === snapshot.xterm.rows
  )
}

/** Arm the e2e seam that delays the reassertion's applied-size read dispatch
 *  past the reveal fit — the ordering a busy daemon or SSH/relay round-trip
 *  produces in the field (pty-applied-size-read-e2e-delay.ts). */
async function armSlowAppliedSizeRead(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((delayMs) => {
    ;(window as StaleResizeReproWindow).__e2ePtyAppliedSizeReadDelayMs = delayMs
  }, delayMs)
}

type CycleDriverArgs = {
  page: Page
  testInfo: TestInfo
  testRepoPath: string
  cycles: number
  label: string
  delaySweepMs?: readonly number[]
  onRevealSample?: (sample: { cycle: number; snapshot: GridSnapshot }) => void
}

async function driveHiddenResizeRevealCycles(args: CycleDriverArgs): Promise<CycleFailure[]> {
  const { page, testInfo, testRepoPath, cycles, label } = args
  await waitForSessionReady(page)
  const firstWorktreeId = await waitForActiveWorktree(page)
  const secondWorktreeId = (await getAllWorktreeIds(page)).find((id) => id !== firstWorktreeId)
  test.skip(!secondWorktreeId, 'stale-resize repro needs the seeded secondary worktree')
  if (!secondWorktreeId) {
    return []
  }

  await page.setViewportSize(VIEWPORTS[0])
  await closeRightSidebarAndFeatureTips(page)

  await switchToWorktree(page, secondWorktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 15_000)

  const runId = Math.random().toString(36).slice(2, 10)
  const scriptPath = path.join(testRepoPath, `.orca-bottom-bar-${runId}.cjs`)
  writeFileSync(scriptPath, bottomBarTuiScript(runId))
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
  await expect
    .poll(() => readGridSnapshot(page, ptyId).then(gridsConverged), {
      timeout: 15_000,
      message: `${label}: applied PTY size should match xterm before cycling`
    })
    .toBe(true)

  const failures: CycleFailure[] = []
  let viewportIndex = 0
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (args.delaySweepMs) {
      await armSlowAppliedSizeRead(page, args.delaySweepMs[cycle % args.delaySweepMs.length])
    }
    await switchToWorktree(page, firstWorktreeId)
    await expect.poll(() => getActiveWorktreeId(page), { timeout: 10_000 }).toBe(firstWorktreeId)
    // Why: the field shape — the window changes while the idle TUI worktree
    // is hidden; hidden xterm refits drop their PTY forwards
    // (isRendererPtyResizeAuthoritative), so the reveal-time readback is the
    // sole owner of the correction.
    viewportIndex = (viewportIndex + 1) % VIEWPORTS.length
    await page.setViewportSize(VIEWPORTS[viewportIndex])
    await page.waitForTimeout(400)

    await switchToWorktree(page, secondWorktreeId)
    await expect.poll(() => getActiveWorktreeId(page), { timeout: 10_000 }).toBe(secondWorktreeId)

    // Why: sample tightly right after reveal — a stale forward that a later
    // follow-up request heals is still the corruption firing (the TUI redraws
    // for the wrong grid in that window); record every desynced sample.
    for (let sample = 0; sample < 20; sample += 1) {
      const snapshot = await readGridSnapshot(page, ptyId)
      if (!gridsConverged(snapshot) && snapshot.xterm !== null && snapshot.applied !== null) {
        args.onRevealSample?.({ cycle, snapshot })
      }
      await page.waitForTimeout(10)
    }

    let lastSnapshot: GridSnapshot = { xterm: null, applied: null }
    const deadline = Date.now() + CONVERGE_TIMEOUT_MS
    let converged = false
    while (Date.now() < deadline) {
      lastSnapshot = await readGridSnapshot(page, ptyId)
      if (gridsConverged(lastSnapshot)) {
        converged = true
        break
      }
      await page.waitForTimeout(150)
    }
    if (!converged) {
      failures.push({ cycle, snapshot: lastSnapshot })
      if (failures.length <= 3) {
        const screenshotPath = testInfo.outputPath(`${label}-cycle-${cycle}.png`)
        await page.screenshot({ path: screenshotPath, fullPage: true })
        await testInfo.attach(`${label}-cycle-${cycle}.png`, {
          path: screenshotPath,
          contentType: 'image/png'
        })
      }
    }
  }
  return failures
}

test.describe('Terminal reveal stale PTY resize repro', () => {
  test('applied PTY size converges across hidden-resize/reveal cycles (natural read ordering)', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(300_000)
    const failures = await driveHiddenResizeRevealCycles({
      page: orcaPage,
      testInfo,
      testRepoPath,
      cycles: 8,
      label: 'natural-order'
    })
    expect(
      failures,
      `PTY applied size stayed desynced from xterm after reveal: ${JSON.stringify(failures)}`
    ).toEqual([])
  })

  test('the PTY is never resized back to its stale pre-reveal grid under slow applied-size reads', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(300_000)
    const staleSamples: { cycle: number; snapshot: GridSnapshot }[] = []
    const failures = await driveHiddenResizeRevealCycles({
      page: orcaPage,
      testInfo,
      testRepoPath,
      cycles: 12,
      label: 'slow-read',
      delaySweepMs: GETSIZE_DELAY_SWEEP_MS,
      onRevealSample: (sample) => staleSamples.push(sample)
    })
    if (staleSamples.length > 0) {
      console.log(`[repro] desynced post-reveal samples: ${JSON.stringify(staleSamples)}`)
    }
    expect(
      staleSamples,
      `PTY applied size diverged from xterm after reveal (stale resize fired): ${JSON.stringify(staleSamples)}`
    ).toEqual([])
    expect(
      failures,
      `PTY stayed desynced from xterm after reveal: ${JSON.stringify(failures)}`
    ).toEqual([])
  })
})
