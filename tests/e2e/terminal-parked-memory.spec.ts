import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

// Why: production cold-park hysteresis is 30s. The fast-park env override is
// scoped to this spec's app launches via orcaAppExtraEnv (same pattern as
// terminal-hidden-view-parking.spec.ts) so it cannot leak into other specs.
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) },
  // Why: without this switch Chromium quantizes performance.memory and only
  // refreshes it every ~20 minutes, so both scenarios report the same stale
  // launch-time bucket instead of a comparable heap figure.
  orcaAppExtraArgs: ['--enable-precise-memory-info']
})

// Why: 8 hidden tabs is below the 12-tab hot-retain limit, but that limit
// never retains anything here — the ORCA_E2E_TERMINAL_PARKING_DELAY_MS
// collapse (terminal-parking-e2e-overrides.ts) shrinks hotRetainMs to the
// same delay as coldParkDelayMs, and the policy cold-parks any tab hidden
// past hotRetainMs before the retain-count limit is even consulted. So all 8
// park without needing 14 tabs or extra policy knobs.
const SCROLLBACK_TAB_COUNT = 8
const SCROLLBACK_LINE_COUNT = 3000
const PARK_SETTLE_MS = 2_000
const HEAP_SAMPLE_COUNT = 5
const HEAP_SAMPLE_INTERVAL_MS = 250
// Why: each test launches a fresh app, fills 8 terminals with ~3000 lines of
// scrollback each, then waits out the parking window — well past the default
// 120s per-test budget.
const PARKED_MEMORY_TEST_TIMEOUT_MS = 300_000

// Why: mixed-width content (ASCII, CJK wide cells, emoji, box drawing) makes
// each xterm hold realistic narrow+wide buffer rows, so released parked-tab
// memory reflects real agent output rather than uniform filler.
function writeScrollbackFillScript(scriptPath: string, runId: string): void {
  const script = [
    `const tabIndex = process.argv[2] ?? '0'`,
    `const wide = '統合端末記憶計測'`,
    `const emoji = ['🟢', '🟡', '🔵', '🟣']`,
    `const lines = []`,
    `for (let i = 0; i < ${SCROLLBACK_LINE_COUNT}; i += 1) {`,
    `  const ascii = ('tab ' + tabIndex + ' line ' + String(i).padStart(4, '0') + ' ').padEnd(48, 'abcdefghijklmnopqrstuvwxyz')`,
    `  const box = '│' + '─'.repeat(8 + (i % 24)) + '│'`,
    `  lines.push(ascii + ' ' + wide.repeat(1 + (i % 3)) + ' ' + emoji[i % 4] + ' ' + box)`,
    `}`,
    `process.stdout.write(lines.join('\\n') + '\\n')`,
    `process.stdout.write('PARKED_MEMORY_FILL_DONE_${runId}_' + tabIndex + '\\n')`
  ].join('\n')
  writeFileSync(scriptPath, `${script}\n`)
}

// Why: the spec lands ahead of the feature wiring in some merge orders. Skip
// (rather than fail) when the app under test does not expose the parking
// debug handle, mirroring terminal-hidden-view-parking.spec.ts.
async function skipUnlessParkingWired(page: Page): Promise<void> {
  const deadline = Date.now() + 2_000
  let present = await page.evaluate(() => window.__terminalParkingDebug !== undefined)
  while (!present && Date.now() < deadline) {
    await page.waitForTimeout(250)
    present = await page.evaluate(() => window.__terminalParkingDebug !== undefined)
  }
  test.skip(
    !present,
    'terminal hidden view parking wiring has not landed (window.__terminalParkingDebug missing)'
  )
}

type TerminalTabViewState = {
  hasManager: boolean
  paneCount: number
}

// Why: TerminalPane unmount deletes its entry from window.__paneManagers, so
// a missing manager is the observable signal that the tab's xterm was parked.
async function readTerminalTabViewState(page: Page, tabId: string): Promise<TerminalTabViewState> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    return {
      hasManager: manager !== undefined,
      paneCount: manager?.getPanes?.().length ?? 0
    }
  }, tabId)
}

async function countMountedPaneManagers(page: Page, tabIds: string[]): Promise<number> {
  return page.evaluate(
    (tabIds) => tabIds.filter((tabId) => window.__paneManagers?.get(tabId) !== undefined).length,
    tabIds
  )
}

async function waitForTabsParked(page: Page, tabIds: string[]): Promise<void> {
  await expect
    .poll(() => countMountedPaneManagers(page, tabIds), {
      timeout: Math.max(30_000, PARKING_DELAY_MS * 10),
      message: 'hidden scrollback tabs did not all park (pane managers still mounted)'
    })
    .toBe(0)
}

type ScrollbackTab = {
  tabId: string
  ptyId: string
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<ScrollbackTab> {
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
  const snapshot = await waitForPaneIdentitySnapshot(page, 1)
  const ptyId = snapshot.panes[0]?.ptyId
  if (snapshot.tabId !== tabId || !ptyId) {
    throw new Error('createActiveTerminalTab: new tab did not bind a PTY')
  }
  return { tabId, ptyId }
}

async function fillActiveTerminalWithScrollback(
  page: Page,
  ptyId: string,
  scriptPath: string,
  tabIndex: number,
  runId: string
): Promise<void> {
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)} ${tabIndex}\r`)
  await expect
    .poll(() => getTerminalContent(page, 4_000), {
      timeout: 30_000,
      message: `scrollback fill marker for tab ${tabIndex} did not render`
    })
    .toContain(`PARKED_MEMORY_FILL_DONE_${runId}_${tabIndex}`)
}

type ScrollbackTabSetup = {
  worktreeId: string
  scrollbackTabs: ScrollbackTab[]
}

// Why: each tab generates its scrollback while visible, so every xterm holds
// the full buffer before going hidden — the hidden-delivery gate never gets a
// chance to drop the output the memory comparison depends on.
async function setUpScrollbackTabs(
  page: Page,
  scriptPath: string,
  runId: string
): Promise<ScrollbackTabSetup> {
  const worktreeId = await waitForActiveWorktree(page)
  await skipUnlessParkingWired(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const baselineSnapshot = await waitForPaneIdentitySnapshot(page, 1)
  const baselinePtyId = baselineSnapshot.panes[0]?.ptyId
  if (!baselinePtyId) {
    throw new Error('parked memory spec: baseline terminal tab did not bind a PTY')
  }

  const scrollbackTabs: ScrollbackTab[] = [{ tabId: baselineSnapshot.tabId, ptyId: baselinePtyId }]
  await fillActiveTerminalWithScrollback(page, baselinePtyId, scriptPath, 0, runId)
  for (let tabIndex = 1; tabIndex < SCROLLBACK_TAB_COUNT; tabIndex += 1) {
    const tab = await createActiveTerminalTab(page, worktreeId)
    scrollbackTabs.push(tab)
    await fillActiveTerminalWithScrollback(page, tab.ptyId, scriptPath, tabIndex, runId)
  }
  return { worktreeId, scrollbackTabs }
}

type ParkedMemoryMetrics = {
  heapUsedMB: number
  liveTerminals: number
  livePaneManagers: number
}

// Why: usedJSHeapSize only drops after a GC, so force one over CDP (best
// effort) and take the min of several settled samples — the min reflects
// retained heap instead of allocation noise between collections. Note xterm
// buffer rows are typed-array backing stores outside the V8 heap, so the
// liveTerminals/livePaneManagers counts are the strong release signal and the
// heap figure tracks only the on-heap share.
async function sampleParkedMemoryMetrics(page: Page): Promise<ParkedMemoryMetrics> {
  await page.waitForTimeout(PARK_SETTLE_MS)
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('HeapProfiler.collectGarbage')
    await session.detach()
  } catch {
    // GC over CDP is a measurement-fidelity improvement, not a gate.
  }

  let minHeapBytes: number | null = null
  for (let sample = 0; sample < HEAP_SAMPLE_COUNT; sample += 1) {
    const heapBytes = await page.evaluate(() => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
      return memory?.usedJSHeapSize ?? null
    })
    if (heapBytes !== null) {
      minHeapBytes = minHeapBytes === null ? heapBytes : Math.min(minHeapBytes, heapBytes)
    }
    await page.waitForTimeout(HEAP_SAMPLE_INTERVAL_MS)
  }
  if (minHeapBytes === null) {
    throw new Error('sampleParkedMemoryMetrics: performance.memory.usedJSHeapSize is unavailable')
  }

  const liveCounts = await page.evaluate(() => ({
    liveTerminals: document.querySelectorAll('.xterm').length,
    livePaneManagers: window.__paneManagers?.size ?? 0
  }))
  return { heapUsedMB: minHeapBytes / (1024 * 1024), ...liveCounts }
}

function formatParkedMemoryAnnotation(metrics: ParkedMemoryMetrics, parkedTabs: number): string {
  return [
    `panes=${SCROLLBACK_TAB_COUNT}`,
    `parkedTabs=${parkedTabs}`,
    `heapUsedMB=${metrics.heapUsedMB.toFixed(1)}`,
    `liveTerminals=${metrics.liveTerminals}`,
    `livePaneManagers=${metrics.livePaneManagers}`
  ].join(' ')
}

test.describe('Terminal parked memory', () => {
  test('releases renderer terminal memory when hidden tabs park', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(PARKED_MEMORY_TEST_TIMEOUT_MS)
    await waitForSessionReady(orcaPage)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-parked-memory-${runId}.mjs`)
    writeScrollbackFillScript(scriptPath, runId)
    try {
      const { worktreeId, scrollbackTabs } = await setUpScrollbackTabs(orcaPage, scriptPath, runId)

      // A fresh 9th tab hides all 8 scrollback tabs.
      const visibleTab = await createActiveTerminalTab(orcaPage, worktreeId)
      await waitForTabsParked(
        orcaPage,
        scrollbackTabs.map((tab) => tab.tabId)
      )

      const metrics = await sampleParkedMemoryMetrics(orcaPage)
      testInfo.annotations.push({
        type: 'opencode-parked-memory',
        description: formatParkedMemoryAnnotation(metrics, scrollbackTabs.length)
      })

      // Structural assertions: all 8 parked (managers gone), and the only
      // live xterm/pane manager belongs to the visible tab.
      for (const tab of scrollbackTabs) {
        expect((await readTerminalTabViewState(orcaPage, tab.tabId)).hasManager).toBe(false)
      }
      const visibleState = await readTerminalTabViewState(orcaPage, visibleTab.tabId)
      expect(visibleState.hasManager).toBe(true)
      expect(visibleState.paneCount).toBeGreaterThan(0)
      // Why: design invariant 5 — renderer terminal views scale with visible
      // panes, so parked tabs must leave no xterm DOM behind.
      expect(metrics.liveTerminals).toBe(visibleState.paneCount)
      expect(metrics.livePaneManagers).toBe(1)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  test('retains terminal views when parking is disabled', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(PARKED_MEMORY_TEST_TIMEOUT_MS)
    await waitForSessionReady(orcaPage)

    // Why: settings.terminalHiddenViewParking === false is the design-doc
    // kill switch. updateSettings persists it through window.api.settings.set
    // and updates the store slice the cold-park hook subscribes to — the same
    // mutation path dead-terminal-repro.spec.ts uses, so no extra launch-env
    // wiring is needed.
    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('parked memory spec: window.__store is unavailable')
      }
      await store.getState().updateSettings({ terminalHiddenViewParking: false })
    })
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => window.__store?.getState().settings?.terminalHiddenViewParking),
        { timeout: 5_000, message: 'terminalHiddenViewParking kill switch did not persist' }
      )
      .toBe(false)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-parked-memory-${runId}.mjs`)
    writeScrollbackFillScript(scriptPath, runId)
    try {
      const { worktreeId, scrollbackTabs } = await setUpScrollbackTabs(orcaPage, scriptPath, runId)
      const scrollbackTabIds = scrollbackTabs.map((tab) => tab.tabId)

      const visibleTab = await createActiveTerminalTab(orcaPage, worktreeId)
      // Why: with parking enabled these tabs park within ~1x the collapsed
      // delay (the first test proves the machinery in this app build), so
      // surviving 3x the delay shows the kill switch held.
      await orcaPage.waitForTimeout(PARKING_DELAY_MS * 3)
      expect(await countMountedPaneManagers(orcaPage, scrollbackTabIds)).toBe(SCROLLBACK_TAB_COUNT)

      const metrics = await sampleParkedMemoryMetrics(orcaPage)
      testInfo.annotations.push({
        type: 'opencode-parked-memory-disabled',
        description: formatParkedMemoryAnnotation(metrics, 0)
      })

      // Structural assertions: every hidden tab keeps its pane manager and
      // xterm; nothing parked even after the settle + sampling window.
      for (const tab of scrollbackTabs) {
        const state = await readTerminalTabViewState(orcaPage, tab.tabId)
        expect(state.hasManager).toBe(true)
        expect(state.paneCount).toBeGreaterThan(0)
      }
      expect((await readTerminalTabViewState(orcaPage, visibleTab.tabId)).hasManager).toBe(true)
      expect(metrics.livePaneManagers).toBe(SCROLLBACK_TAB_COUNT + 1)
      expect(metrics.liveTerminals).toBe(SCROLLBACK_TAB_COUNT + 1)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
