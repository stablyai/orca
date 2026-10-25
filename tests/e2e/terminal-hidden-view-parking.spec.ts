import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { alternateScreenFixtureScript } from './alternate-screen-fixture-script'
import { test, expect } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
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
import { parkHiddenTabBehindDecoy, waitForTabParked } from './helpers/terminal-hidden-parking'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { TERMINAL_TAB_PARK_FLIP_WINDOW_MS } from '../../src/renderer/src/components/terminal-pane/terminal-park-verdict-flip-telemetry'

// Dev/exposeStore parking wiring exposes this handle and the applied delay override.
type ParkingDebugWindow = Window & {
  __terminalParkingDebug?: {
    parkDelayMs?: number
  }
}

// Scope fast-park env to these launches; module-level process.env leaked to later specs on worker reload.
// Production uses a 30s cold delay and multi-minute hot retention.
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

const PARKED_FRAME_SCRIPT_DELAY_MS = 750
const PARKED_FRAME_COUNT = 25
const PARK_VERDICT_WINDOW_SETTLE_MS = Math.ceil(TERMINAL_TAB_PARK_FLIP_WINDOW_MS / 5)

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
    alternateScreenFixtureScript(frames.join(''), PARKED_FRAME_SCRIPT_DELAY_MS)
  )
}

// Hold one rich alt-screen frame (boxes, SGR, wide glyphs) unchanged so reveal drift is detectable without spinner churn.
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
  writeFileSync(scriptPath, alternateScreenFixtureScript(cycleReferenceFrame(runId)))
}

// Compare content rows: serialize() cursor-restore trailers vary without visible changes; strip trailers and whitespace-only tail rows.
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

// Allow merge-order compatibility: skip builds without parking’s debug handle.
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

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
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
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
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

// Start each scenario with tab A live in the active worktree; callers hide it with new tabs.
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
      const parkDetectedAfterMs = await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabAId, {
        parkDelayMs: PARKING_DELAY_MS
      })
      const wiring = await readParkingWiring(orcaPage)
      testInfo.annotations.push({
        type: 'terminal-parking',
        description: `parkDelayMs=${wiring.parkDelayMs ?? PARKING_DELAY_MS} parkDetectedAfterMs=${parkDetectedAfterMs}`
      })

      // Require tab-scoped teardown: more-recently-hidden tab B stays warm under #8262.
      const tabBState = await readTerminalTabViewState(orcaPage, tabBId)
      expect(tabBState.hasManager).toBe(true)
      expect(tabBState.paneCount).toBeGreaterThan(0)

      await activateTerminalTab(orcaPage, tabAId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const revealedSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(revealedSnapshot.tabId).toBe(tabAId)
      // Parking tears down only the renderer; require the same surviving PTY on reveal.
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

      // Interrupt the fixture TUI and wait for shell ownership before probing input.
      await sendToTerminal(orcaPage, tabAPtyId, '\x03')
      // Rethrow with Ctrl-C context: readiness can look like a dead shell when ConPTY did not translate the interrupt.
      await waitForPtyShellEcho(orcaPage, tabAPtyId, 15_000).catch((error: unknown) => {
        throw new Error(
          `Ctrl-C did not hand the PTY back from the fixture TUI: ${error instanceof Error ? error.message : String(error)}`
        )
      })

      // The joined marker exists only in command output, proving execution beyond echo.
      const typedMarker = `PARKED_TYPED_OK_${runId}`
      const typedProbeScript = `console.log('PARKED_TYPED_OK_' + '${runId}')`
      // Why: delivered via a temp file — `node -e` quoting is not PowerShell-safe (#8521).
      await runNodeScriptInTerminal(orcaPage, tabAPtyId, typedProbeScript, {
        prefix: 'orca-parked-typed-probe'
      })
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
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabAId, {
      parkDelayMs: PARKING_DELAY_MS
    })

    const runId = randomUUID()
    const parkedTitle = `Parked side effects ${runId}`
    const marker = `PARKED_SIDE_EFFECT_MARKER_${runId}`
    // Emit OSC 0, standalone BEL and reveal marker; OSC’s terminator must not count as a bell.
    // Keep alive 30s so the shell prompt cannot overwrite the title.
    const payload = `\x1b]0;${parkedTitle}\x07\x07${marker}\n`
    const sideEffectScript = `process.stdout.write(${JSON.stringify(payload)}); setTimeout(() => process.exit(0), 30000)`
    // Why: delivered via a temp file — `node -e` quoting is not PowerShell-safe (#8521).
    await runNodeScriptInTerminal(orcaPage, tabAPtyId, sideEffectScript, {
      prefix: 'orca-parked-side-effect'
    })

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

    // Require side effects from the pane-less watcher without waking the parked view.
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

    // Queue tab C’s parking-excluding startup command after mount so mount-time consume cannot drain it.
    const tabCId = await createActiveTerminalTab(orcaPage, worktreeId)
    await orcaPage.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        throw new Error('parking exclusion spec: window.__store is unavailable')
      }
      store.getState().queueTabStartupCommand(tabId, { command: 'echo parked-exclusion-probe' })
    }, tabCId)
    expect(await hasPendingStartupCommand(orcaPage, tabCId)).toBe(true)

    const tabBId = await createActiveTerminalTab(orcaPage, worktreeId)
    await expect
      .poll(() => getActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'tab B did not stay active while waiting on the parking window'
      })
      .toBe(tabBId)

    // Tab A parking proves this app crossed the delay; a decoy takes #8262’s last-active exemption while pending-startup C is excluded.
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabAId, {
      parkDelayMs: PARKING_DELAY_MS
    })
    await orcaPage.waitForTimeout(PARKING_DELAY_MS * 3)

    // Premise guard: nothing consumed the pending startup while hidden.
    expect(await hasPendingStartupCommand(orcaPage, tabCId)).toBe(true)
    const tabCState = await readTerminalTabViewState(orcaPage, tabCId)
    expect(tabCState.hasManager).toBe(true)
    expect(tabCState.paneCount).toBeGreaterThan(0)
  })

  // Require identical rich content across 25 teardown→snapshot-restore→reattach cycles to catch individual or accumulated garble.
  test('reproduces a static frame byte-for-byte across 25 park/reveal cycles', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(420_000)
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

      // Toggle A/B while a later-hidden decoy takes #8262’s exemption so A cold-parks.
      const tabBId = await createActiveTerminalTab(orcaPage, worktreeId)
      const decoyTabId = await createActiveTerminalTab(orcaPage, worktreeId)

      // Baseline after one reveal: alt restore intentionally drops normal-buffer scrollback (scrollback 0), including shell command echo.
      // Compare subsequent cycles through identical machinery so expected omission cannot masquerade as garble.
      const runOneParkRevealCycle = async (cycle: number): Promise<string[]> => {
        await activateTerminalTab(orcaPage, tabBId)
        await activateTerminalTab(orcaPage, decoyTabId)
        await waitForTabParked(orcaPage, tabAId, { parkDelayMs: PARKING_DELAY_MS })
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
        expect(rows.join('\n')).not.toContain('Orca skipped hidden terminal output')
        return rows
      }

      const referenceRows = await runOneParkRevealCycle(0)
      expect(referenceRows.join('\n')).toContain(marker)
      expect(referenceRows.join('\n')).toContain('╭')

      // waitForTabParked throws each cycle, ruling out a pass without parking.
      const CYCLES = 25
      const mismatches: string[] = []
      for (let cycle = 1; cycle < CYCLES; cycle++) {
        // Each cycle flips the rendered verdict twice; stay below the 12-flip sustained-churn pin in 60s.
        await orcaPage.waitForTimeout(PARK_VERDICT_WINDOW_SETTLE_MS)
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
