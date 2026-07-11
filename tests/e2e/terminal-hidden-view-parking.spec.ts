import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getWorktreeTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

// Why: the parking wiring registers this handle (dev/exposeStore builds only)
// so tests can detect that hidden-view parking is compiled in and which delay
// override the app actually applied.
type ParkingDebugWindow = Window & {
  __terminalParkingDebug?: {
    parkDelayMs?: number
  }
}

// Why: production cold-park hysteresis is 30s with a multi-minute hot-retain
// window. The fast-park override must be scoped to THIS spec's app launches —
// mutating process.env at module scope leaked into later specs when a worker
// reloaded files without replaying this file's afterAll.
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

const PARKED_FRAME_SCRIPT_DELAY_MS = 750
const PARKED_FRAME_COUNT = 25

function parkedTuiFrame(runId: string, frame: number): string {
  const progress = `${'█'.repeat((frame % 8) + 1)}${'░'.repeat(8 - ((frame % 8) + 1))}`
  const rows = [
    '╭────────────────────────────────────────────────────────────────────╮',
    `│ Parked view restore Frame ${String(frame).padStart(3, '0')} ${frame % 2 === 0 ? '🟢' : '🟡'} ${progress} │`,
    '├──────────────┬──────────────────────┬──────────────────────────────┤',
    `│ model        │ codex/opencode       │ ${runId.slice(0, 28).padEnd(28)} │`,
    `│ status       │ ${frame % 2 === 0 ? 'thinking' : 'streaming'}            │ input ${'#'.repeat((frame % 18) + 1).padEnd(22)} │`,
    `│ diff         │ +${String(frame * 3).padEnd(19)} │ -${String(frame).padEnd(27)} │`,
    '╰──────────────┴──────────────────────┴──────────────────────────────╯',
    `PARKED_RESTORE_FINAL_${runId}_${frame}`
  ]
  return [
    '\x1b[?2026h',
    '\x1b[?1049h',
    '\x1b[2J\x1b[H',
    '\x1b[?25l',
    rows.map((row) => `\x1b[2;36m${row}\x1b[0m`).join('\r\n'),
    '\x1b[10;18H\x1b[?25h',
    '\x1b[?2026l'
  ].join('')
}

function writeParkedFrameScript(scriptPath: string, runId: string): void {
  const frames = Array.from({ length: PARKED_FRAME_COUNT }, (_, frame) =>
    parkedTuiFrame(runId, frame)
  )
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    `setTimeout(() => process.stdout.write(${JSON.stringify(frames.join(''))}), ${PARKED_FRAME_SCRIPT_DELAY_MS})\n`
  )
}

// Deterministic static alt-screen frame for the park/reveal cycle test: rich
// styling (box drawing, SGR colors, wide glyphs) that exercises the snapshot
// restore, painted once and held so the on-screen content is stable across
// cycles. No spinner/progress churn — the frame must be byte-identical every
// reveal so drift is detectable.
function cycleReferenceFrame(runId: string): string {
  const rows = [
    '╭──────────────────────────────────────────────────────────╮',
    `│ Park/reveal cycle reference ${runId.slice(0, 8)} 🟢 你好世界 터미널  │`,
    '├───────────────┬──────────────────────────────────────────┤',
    `│ model         │ \x1b[1mcodex/opencode\x1b[22m stream +142 -37        │`,
    `│ status        │ \x1b[38;5;204mrunning\x1b[0m\x1b[2;36m diff --git a/pty.ts esc↩     │`,
    '╰───────────────┴──────────────────────────────────────────╯',
    `CYCLE_REFERENCE_${runId}`
  ]
  return [
    '\x1b[?1049h',
    '\x1b[2J\x1b[H',
    '\x1b[?25l',
    rows.map((row) => `\x1b[2;36m${row}\x1b[0m`).join('\r\n'),
    '\x1b[?25h'
  ].join('')
}

function writeCycleReferenceScript(scriptPath: string, runId: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  // Paint the frame once, then hold the process open so the alt-screen TUI
  // stays on screen (and the parkable PTY session stays alive) across cycles.
  writeFileSync(
    scriptPath,
    `process.stdout.write(${JSON.stringify(cycleReferenceFrame(runId))}); setInterval(() => {}, 1000)\n`
  )
}

// Why: serialize() re-emits the buffer with cursor-restore trailer sequences
// (ESC[…H, ESC[?25h) and the exact CSI form can differ run-to-run without any
// visible change. Compare the CONTENT rows, not the trailer — strip trailing
// control sequences and normalize whitespace-only tail lines.
function terminalContentRows(serialized: string): string[] {
  // eslint-disable-next-line no-control-regex
  const stripped = serialized.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  return stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
}

async function readParkingWiring(
  page: Page
): Promise<{ present: boolean; parkDelayMs: number | null }> {
  return page.evaluate(() => {
    const debug = (window as ParkingDebugWindow).__terminalParkingDebug
    return { present: debug !== undefined, parkDelayMs: debug?.parkDelayMs ?? null }
  })
}

// Why: the spec lands ahead of the feature wiring. Skip (rather than fail)
// when the app under test does not expose the parking debug handle so this
// file is safe to merge in any order with the wiring branch.
async function skipUnlessParkingWired(page: Page): Promise<void> {
  const deadline = Date.now() + 2_000
  let wiring = await readParkingWiring(page)
  while (!wiring.present && Date.now() < deadline) {
    await page.waitForTimeout(250)
    wiring = await readParkingWiring(page)
  }
  test.skip(
    !wiring.present,
    'terminal hidden view parking wiring has not landed (window.__terminalParkingDebug missing)'
  )
}

type TerminalTabViewState = {
  hasManager: boolean
  paneCount: number
}

async function readTerminalTabViewState(page: Page, tabId: string): Promise<TerminalTabViewState> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    return {
      hasManager: manager !== undefined,
      paneCount: manager?.getPanes?.().length ?? 0
    }
  }, tabId)
}

// Why: TerminalPane unmount deletes its entry from window.__paneManagers, so a
// missing manager is the observable signal that the tab's xterm was parked.
async function waitForTabParked(page: Page, tabId: string): Promise<number> {
  const parkWaitStartedAt = Date.now()
  await expect
    .poll(async () => (await readTerminalTabViewState(page, tabId)).hasManager, {
      timeout: Math.max(20_000, PARKING_DELAY_MS * 10),
      message: `terminal tab ${tabId} did not park (pane manager still mounted)`
    })
    .toBe(false)
  return Date.now() - parkWaitStartedAt
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal')
    state.setActiveTab(targetTabId)
  }, tabId)

  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: `terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)

  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: 'newly created terminal tab did not become active'
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  return tabId
}

async function getUnreadTerminalTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.keys(store.getState().unreadTerminalTabs)
  })
}

async function isWorktreeUnread(page: Page, worktreeId: string): Promise<boolean> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      return false
    }
    const worktree = Object.values(store.getState().worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    return worktree?.isUnread === true
  }, worktreeId)
}

async function getTerminalTabTitle(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<string | null> {
  const tabs = await getWorktreeTabs(page, worktreeId)
  return tabs.find((tab) => tab.id === tabId)?.title ?? null
}

async function hasPendingStartupCommand(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate((tabId) => {
    const store = window.__store
    if (!store) {
      return false
    }
    return store.getState().pendingStartupByTabId[tabId] !== undefined
  }, tabId)
}

type ParkableTabSetup = {
  worktreeId: string
  tabAId: string
  tabAPtyId: string
}

// Why: every scenario starts from the same shape — tab A live in the active
// worktree; callers then create more tabs on top so tab A goes hidden.
async function setUpParkableTabA(page: Page): Promise<ParkableTabSetup> {
  const worktreeId = await waitForActiveWorktree(page)
  await skipUnlessParkingWired(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const tabASnapshot = await waitForPaneIdentitySnapshot(page, 1)
  const tabAPtyId = tabASnapshot.panes[0]?.ptyId
  if (!tabAPtyId) {
    throw new Error('parking spec tab A did not bind a PTY')
  }
  return {
    worktreeId,
    tabAId: tabASnapshot.tabId,
    tabAPtyId
  }
}

test.describe('Terminal hidden view parking', () => {
  test('parks a hidden terminal tab and restores rich TUI output on reveal', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    const setup = await setUpParkableTabA(orcaPage)
    const { worktreeId, tabAId, tabAPtyId } = setup

    const runId = randomUUID()
    const finalMarker = `PARKED_RESTORE_FINAL_${runId}_${PARKED_FRAME_COUNT - 1}`
    const scriptPath = path.join(testRepoPath, `.orca-parked-rich-tui-${runId}.mjs`)
    writeParkedFrameScript(scriptPath, runId)
    try {
      await sendToTerminal(orcaPage, tabAPtyId, `node ${JSON.stringify(scriptPath)}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 12_000), {
          timeout: 15_000,
          message: 'rich TUI final frame did not render while tab A was visible'
        })
        .toContain(finalMarker)

      const tabBId = await createActiveTerminalTab(orcaPage, worktreeId)
      const parkDetectedAfterMs = await waitForTabParked(orcaPage, tabAId)
      const wiring = await readParkingWiring(orcaPage)
      testInfo.annotations.push({
        type: 'terminal-parking',
        description: `parkDelayMs=${wiring.parkDelayMs ?? PARKING_DELAY_MS} parkDetectedAfterMs=${parkDetectedAfterMs}`
      })

      // Why: parking must be scoped to the hidden tab — the visible tab keeps
      // a live pane manager and xterm.
      const tabBState = await readTerminalTabViewState(orcaPage, tabBId)
      expect(tabBState.hasManager).toBe(true)
      expect(tabBState.paneCount).toBeGreaterThan(0)

      await activateTerminalTab(orcaPage, tabAId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const revealedSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(revealedSnapshot.tabId).toBe(tabAId)
      // Why: parking only tears down the renderer view; the PTY session must
      // survive so reveal reattaches to the same shell.
      expect(revealedSnapshot.panes[0]?.ptyId).toBe(tabAPtyId)

      await expect
        .poll(() => getTerminalContent(orcaPage, 12_000), {
          timeout: 15_000,
          message: 'parked rich TUI frame did not restore when the tab was revealed'
        })
        .toContain(finalMarker)

      const content = await getTerminalContent(orcaPage, 12_000)
      expect(content).toContain(`Frame ${String(PARKED_FRAME_COUNT - 1).padStart(3, '0')}`)
      expect(content).toContain('╭')
      expect(content).toContain('├')
      expect(content).toContain('█')
      expect(content).not.toContain('Orca skipped hidden terminal output')

      // Why: the typed marker only appears joined in command *output*, so this
      // proves the revealed terminal accepts input end-to-end, not just echo.
      const typedMarker = `PARKED_TYPED_OK_${runId}`
      const typedProbeScript = `console.log('PARKED_TYPED_OK_' + '${runId}')`
      await sendToTerminal(orcaPage, tabAPtyId, `node -e ${JSON.stringify(typedProbeScript)}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 12_000), {
          timeout: 10_000,
          message: 'revealed terminal did not execute and display typed input'
        })
        .toContain(typedMarker)

      const screenshotPath = testInfo.outputPath('parked-tab-restore-final.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('parked-tab-restore-final.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps bell and title side effects live while parked', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const setup = await setUpParkableTabA(orcaPage)
    const { worktreeId, tabAId, tabAPtyId } = setup

    await createActiveTerminalTab(orcaPage, worktreeId)
    await waitForTabParked(orcaPage, tabAId)

    const runId = randomUUID()
    const parkedTitle = `Parked side effects ${runId}`
    const marker = `PARKED_SIDE_EFFECT_MARKER_${runId}`
    // Why: OSC 0 title first, then a standalone BEL (the OSC terminator BEL
    // must not count as a bell), then a content marker for the reveal check.
    // The 30s keep-alive stops the shell prompt from overwriting the title
    // before the store assertion lands.
    const payload = `\x1b]0;${parkedTitle}\x07\x07${marker}\n`
    const sideEffectScript = `process.stdout.write(${JSON.stringify(payload)}); setTimeout(() => process.exit(0), 30000)`
    await sendToTerminal(orcaPage, tabAPtyId, `node -e ${JSON.stringify(sideEffectScript)}\r`)

    await expect
      .poll(() => getTerminalTabTitle(orcaPage, worktreeId, tabAId), {
        timeout: 10_000,
        message: 'parked OSC 0 title did not update the tab title in the store'
      })
      .toBe(parkedTitle)
    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(tabAId), {
        timeout: 10_000,
        message: 'parked BEL did not mark the terminal tab unread'
      })
      .toBe(true)
    await expect
      .poll(() => isWorktreeUnread(orcaPage, worktreeId), {
        timeout: 10_000,
        message: 'parked BEL did not mark the worktree unread'
      })
      .toBe(true)

    // Why: side effects must come from the pane-less watcher — the burst must
    // not have woken the parked view back up.
    expect((await readTerminalTabViewState(orcaPage, tabAId)).hasManager).toBe(false)

    await activateTerminalTab(orcaPage, tabAId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 15_000,
        message: 'parked side-effect marker did not restore when the tab was revealed'
      })
      .toContain(marker)
  })

  test('does not park excluded tabs', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const setup = await setUpParkableTabA(orcaPage)
    const { worktreeId, tabAId } = setup

    // Tab C: parking-excluded because it has a pending startup command. Queue
    // it after the pane mounted so the mount-time consume cannot drain it.
    const tabCId = await createActiveTerminalTab(orcaPage, worktreeId)
    await orcaPage.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        throw new Error('parking exclusion spec: window.__store is unavailable')
      }
      store.getState().queueTabStartupCommand(tabId, { command: 'echo parked-exclusion-probe' })
    }, tabCId)
    expect(await hasPendingStartupCommand(orcaPage, tabCId)).toBe(true)

    // Tab B on top hides both A and C.
    const tabBId = await createActiveTerminalTab(orcaPage, worktreeId)
    await expect
      .poll(() => getActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'tab B did not stay active while waiting on the parking window'
      })
      .toBe(tabBId)

    // Why: tab A parking proves the machinery ran past the delay in this app
    // instance, so the tab C assertion below is not vacuously green.
    await waitForTabParked(orcaPage, tabAId)
    await orcaPage.waitForTimeout(PARKING_DELAY_MS * 3)

    // Premise guard: nothing consumed the pending startup while hidden.
    expect(await hasPendingStartupCommand(orcaPage, tabCId)).toBe(true)
    const tabCState = await readTerminalTabViewState(orcaPage, tabCId)
    expect(tabCState.hasManager).toBe(true)
    expect(tabCState.paneCount).toBeGreaterThan(0)
  })

  // Drives 25 deterministic park→reveal cycles on a static rich TUI frame and
  // asserts every reveal reproduces the SAME content the tab showed while it was
  // continuously visible (the never-parked reference). This is the field-garble
  // guard end-to-end: it exercises the real renderer teardown + HeadlessEmulator
  // snapshot restore + PTY reattach path the fuzz suites model in isolation, and
  // fails if any single cycle — or accumulated drift across 25 — garbles a cell.
  test('reproduces a static frame byte-for-byte across 25 park/reveal cycles', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const setup = await setUpParkableTabA(orcaPage)
    const { worktreeId, tabAId, tabAPtyId } = setup

    const runId = randomUUID()
    const marker = `CYCLE_REFERENCE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-cycle-reference-${runId}.mjs`)
    writeCycleReferenceScript(scriptPath, runId)
    try {
      await sendToTerminal(orcaPage, tabAPtyId, `node ${JSON.stringify(scriptPath)}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 12_000), {
          timeout: 15_000,
          message: 'cycle reference frame did not render while tab A was visible'
        })
        .toContain(marker)

      // Tab B stays visible whenever tab A is parked; toggling the active tab
      // between them is the deterministic hide/reveal driver.
      const tabBId = await createActiveTerminalTab(orcaPage, worktreeId)

      // One park/reveal cycle to run the frame through the snapshot restore for a
      // baseline. Why not compare against the visible-before-park content: an
      // alt-screen restore deliberately drops the normal-buffer scrollback
      // (serializeHeadlessTerminalBuffer forces scrollback 0 under alt), so the
      // pre-park serialize carries the shell command echo the restore correctly
      // omits — that is contract, not garble. Baselining after one reveal makes
      // both sides pass through identical machinery, so any later diff is drift.
      const runOneParkRevealCycle = async (cycle: number): Promise<string[]> => {
        await activateTerminalTab(orcaPage, tabBId)
        await waitForTabParked(orcaPage, tabAId)
        await activateTerminalTab(orcaPage, tabAId)
        await waitForActiveTerminalManager(orcaPage, 30_000)
        const revealed = await waitForPaneIdentitySnapshot(orcaPage, 1)
        expect(revealed.panes[0]?.ptyId).toBe(tabAPtyId)
        await expect
          .poll(() => getTerminalContent(orcaPage, 12_000), {
            timeout: 15_000,
            message: `cycle ${cycle}: reference frame did not restore on reveal`
          })
          .toContain(marker)
        const rows = terminalContentRows(await getTerminalContent(orcaPage, 12_000))
        // Garble sentinel: the hidden-skip banner must never appear.
        expect(rows.join('\n')).not.toContain('Orca skipped hidden terminal output')
        return rows
      }

      const referenceRows = await runOneParkRevealCycle(0)
      expect(referenceRows.join('\n')).toContain(marker)
      expect(referenceRows.join('\n')).toContain('╭')

      // waitForTabParked (inside runOneParkRevealCycle) throws if the tab never
      // parked, so reaching here means the machinery ran every cycle — no
      // separate premise guard needed for a vacuous-green check.
      const CYCLES = 25
      const mismatches: string[] = []
      for (let cycle = 1; cycle < CYCLES; cycle++) {
        const rows = await runOneParkRevealCycle(cycle)
        if (JSON.stringify(rows) !== JSON.stringify(referenceRows)) {
          mismatches.push(
            `cycle ${cycle}:\n  expected: ${JSON.stringify(referenceRows)}\n  actual:   ${JSON.stringify(rows)}`
          )
        }
      }

      testInfo.annotations.push({
        type: 'terminal-parking-cycles',
        description: `cycles=${CYCLES} mismatches=${mismatches.length}`
      })
      expect(
        mismatches,
        `park/reveal drift across ${CYCLES} cycles:\n${mismatches.join('\n')}`
      ).toEqual([])

      const screenshotPath = testInfo.outputPath('park-reveal-25-cycles-final.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('park-reveal-25-cycles-final.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
