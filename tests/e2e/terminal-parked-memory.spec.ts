import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getAllWorktreeIds,
  switchToWorktree,
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
// past hotRetainMs before the retain-count limit is even consulted. The one
// exception is the last-active (most-recently-hidden) tab, which is exempt
// from parking so returning to it is instant — so 7 of the 8 park.
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
function writeScrollbackFillScript(
  scriptPath: string,
  runId: string,
  lineCount: number = SCROLLBACK_LINE_COUNT
): void {
  const script = [
    `const tabIndex = process.argv[2] ?? '0'`,
    `const wide = '統合端末記憶計測'`,
    `const emoji = ['🟢', '🟡', '🔵', '🟣']`,
    `const lines = []`,
    `for (let i = 0; i < ${lineCount}; i += 1) {`,
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

// Why: the last-active tab per worktree is exempt from parking so returning to
// it is instant, so one of the hidden scrollback tabs stays mounted. The
// exempt one is the most-recently-hidden — here the last scrollback tab filled
// before the visible tab was created — so we expect exactly one still mounted.
async function waitForTabsParkedExceptLastActive(page: Page, tabIds: string[]): Promise<void> {
  await expect
    .poll(() => countMountedPaneManagers(page, tabIds), {
      timeout: Math.max(30_000, PARKING_DELAY_MS * 10),
      message: 'hidden scrollback tabs did not park down to the last-active exemption'
    })
    .toBe(1)
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

      // A fresh 9th tab hides all 8 scrollback tabs. The last one filled is the
      // most-recently-hidden, so it stays warm under the last-active exemption;
      // the other 7 park.
      const visibleTab = await createActiveTerminalTab(orcaPage, worktreeId)
      const lastActiveTab = scrollbackTabs.at(-1)
      if (!lastActiveTab) {
        throw new Error('parked memory spec: no scrollback tabs were created')
      }
      const parkableTabs = scrollbackTabs.slice(0, -1)
      await waitForTabsParkedExceptLastActive(
        orcaPage,
        scrollbackTabs.map((tab) => tab.tabId)
      )

      const metrics = await sampleParkedMemoryMetrics(orcaPage)
      testInfo.annotations.push({
        type: 'opencode-parked-memory',
        description: formatParkedMemoryAnnotation(metrics, parkableTabs.length)
      })

      // Structural assertions: the 7 non-last-active tabs parked (managers
      // gone); the visible tab and the exempt last-active tab keep theirs.
      for (const tab of parkableTabs) {
        expect((await readTerminalTabViewState(orcaPage, tab.tabId)).hasManager).toBe(false)
      }
      expect((await readTerminalTabViewState(orcaPage, lastActiveTab.tabId)).hasManager).toBe(true)
      const visibleState = await readTerminalTabViewState(orcaPage, visibleTab.tabId)
      expect(visibleState.hasManager).toBe(true)
      expect(visibleState.paneCount).toBeGreaterThan(0)
      // Why: design invariant 5 — renderer terminal views scale with mounted
      // panes; only the visible tab and the exempt last-active tab keep an
      // xterm and pane manager, everything else parks.
      expect(metrics.livePaneManagers).toBe(2)
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

// ─────────────────────── C1 retention budget outcome ───────────────────────
// The tests above assert the parking MECHANISM. This one asserts the OUTCOME
// the retention budget exists for: hidden worktrees ordinary parking can never
// evict actually release their buffers once the budget engages, with the
// budget flip as the only change between the two samples.
//
// Honest caveats:
//  - The un-parkable class is staged by rewriting tabsByWorktree[*].ptyId to a
//    remote-runtime-shaped id. That is a fidelity proxy: park-restorability and
//    eviction-exemption are decided from that field alone, but the transports
//    underneath stay real LOCAL PTYs — this is not a live remote runtime.
//  - The primary gate is retained xterm buffer CELLS (deterministic), not RSS.
//    xterm rows are typed arrays outside the V8 heap, so usedJSHeapSize misses
//    most of what is released; renderer RSS is recorded and only gated as
//    non-growth because it moves with GC timing and compositor allocations.
const RETENTION_TAB_COUNT = 4
const RETENTION_FILL_LINE_COUNT = 12_000
const RETENTION_SCROLLBACK_ROWS = 25_000
// Why 12: xterm packs each cell as 3 uint32s in the BufferLine typed array.
const XTERM_BYTES_PER_CELL = 12
// Why 40: this staging measures ~87 MB of retained buffer, so half of that is a
// floor that fails loudly if the fill silently stops producing scrollback.
const MIN_STAGED_BUFFER_MB = 40
// Why 2s: force-park is a synchronous verdict re-run on the setting flip and
// measured 23-25ms locally; anything near a timer/TTL wait blows this budget.
const MAX_FORCE_PARK_EVICTION_MS = 2_000
// Why 0.05: only the exempt decoy's unfilled pane may survive (~0.1% of the
// baseline). One retained filled pane would be ~25%, so this fails on a partial
// eviction instead of passing it.
const MAX_RETAINED_CELL_FRACTION = 0.05
// Why a band, not zero: RSS is sampled and moved only -0.7 to -3.0 MB on a
// ~453 MB baseline across runs, so "must not grow" would flake on noise. 5 MB
// still fails loudly if an eviction starts planting 512KB/pane capture strings.
const RENDERER_RSS_NOISE_MB = 5
const RETENTION_TEST_TIMEOUT_MS = 420_000
const UNPARKABLE_PTY_PREFIX = 'remote:e2e-retention-'

type RetainedBufferSample = {
  cells: number
  rows: number
  panes: number
}

// Why walk the buffers instead of trusting a heap delta: xterm rows live in
// typed arrays outside the V8 heap, so retained cells are the only
// deterministic measure of what a force-park actually released.
async function readRetainedTerminalBufferCells(page: Page): Promise<RetainedBufferSample> {
  return page.evaluate(() => {
    let cells = 0
    let rows = 0
    let panes = 0
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        const buffer = pane.terminal?.buffer?.active
        if (!buffer) {
          continue
        }
        panes += 1
        rows += buffer.length
        cells += buffer.length * pane.terminal.cols
      }
    }
    return { cells, rows, panes }
  })
}

// Why host-side RSS: the renderer process' resident set is the figure the C1
// crash reports are measured in, and performance.memory cannot see it.
async function readRendererResidentMb(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const snapshot = await window.api?.memory?.getSnapshot?.()
    const bytes = snapshot?.app?.renderer?.memory
    return typeof bytes === 'number' && bytes > 0 ? bytes / (1024 * 1024) : null
  })
}

type RetentionMemorySample = {
  buffers: RetainedBufferSample
  bufferMb: number
  heapUsedMb: number
  rendererMb: number | null
  livePaneManagers: number
}

async function readRetentionMemorySample(page: Page): Promise<RetentionMemorySample> {
  const metrics = await sampleParkedMemoryMetrics(page)
  const buffers = await readRetainedTerminalBufferCells(page)
  return {
    buffers,
    bufferMb: (buffers.cells * XTERM_BYTES_PER_CELL) / (1024 * 1024),
    heapUsedMb: metrics.heapUsedMB,
    rendererMb: await readRendererResidentMb(page),
    livePaneManagers: metrics.livePaneManagers
  }
}

function formatRetentionSample(label: string, sample: RetentionMemorySample): string {
  return [
    `${label}.cells=${sample.buffers.cells}`,
    `${label}.rows=${sample.buffers.rows}`,
    `${label}.panes=${sample.buffers.panes}`,
    `${label}.bufferMB=${sample.bufferMb.toFixed(1)}`,
    `${label}.heapMB=${sample.heapUsedMb.toFixed(1)}`,
    `${label}.rendererRssMB=${sample.rendererMb === null ? 'n/a' : sample.rendererMb.toFixed(1)}`,
    `${label}.paneManagers=${sample.livePaneManagers}`
  ].join(' ')
}

// Why rewrite only tab.ptyId: canPark* eligibility is decided from it, so a
// remote-runtime-shaped id makes the worktree un-parkable. Layout leaf maps
// stay on real local transports so live panes keep their bindings; watcher
// coverage may still read those locals, but eligibility already fails.
async function stageUnparkableWorktreeTabs(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    ({ worktreeId, prefix }) => {
      const store = window.__store
      if (!store) {
        throw new Error('stageUnparkableWorktreeTabs: window.__store is unavailable')
      }
      const state = store.getState()
      const tabs = state.tabsByWorktree[worktreeId] ?? []
      if (tabs.length === 0) {
        throw new Error(`stageUnparkableWorktreeTabs: ${worktreeId} has no terminal tabs`)
      }
      const staged = tabs.map((tab) =>
        typeof tab.ptyId === 'string' && tab.ptyId.startsWith(prefix)
          ? tab
          : { ...tab, ptyId: `${prefix}${tab.id}` }
      )
      ;(store as unknown as { setState: (partial: unknown) => void }).setState({
        tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: staged }
      })
      return staged.length
    },
    { worktreeId, prefix: UNPARKABLE_PTY_PREFIX }
  )
}

// Why: bind/reconcile can rewrite tab.ptyId after staging. Poll so ordinary
// parking cannot regain park-restorable eligibility mid control-arm wait.
async function waitForUnparkableWorktreeTabs(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ worktreeId, prefix }) => {
            const tabs = window.__store?.getState().tabsByWorktree[worktreeId] ?? []
            return (
              tabs.length > 0 &&
              tabs.every((tab) => typeof tab.ptyId === 'string' && tab.ptyId.startsWith(prefix))
            )
          },
          { worktreeId, prefix: UNPARKABLE_PTY_PREFIX }
        ),
      {
        timeout: 5_000,
        message: `worktree ${worktreeId} did not keep un-parkable remote: pty ids after staging`
      }
    )
    .toBe(true)
}

// Why not getTerminalContent: it serializes the whole scrollback, which is
// megabytes of string per poll tick at RETENTION_SCROLLBACK_ROWS. The fill
// marker is the last line written, so scanning the buffer tail is enough.
async function waitForFillMarkerInTab(page: Page, tabId: string, marker: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ tabId, marker }) => {
            const manager = window.__paneManagers?.get(tabId)
            const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
            const buffer = pane?.terminal?.buffer?.active
            if (!buffer) {
              return false
            }
            const firstRow = Math.max(0, buffer.length - 200)
            for (let row = buffer.length - 1; row >= firstRow; row -= 1) {
              if (buffer.getLine(row)?.translateToString(true).includes(marker) === true) {
                return true
              }
            }
            return false
          },
          { tabId, marker }
        ),
      { timeout: 90_000, message: `scrollback fill marker ${marker} did not render` }
    )
    .toBe(true)
}

async function updateTerminalSettings(
  page: Page,
  patch: { terminalHiddenWorktreeRetentionBudget?: boolean; terminalScrollbackRows?: number }
): Promise<void> {
  await page.evaluate(async (patch) => {
    const store = window.__store
    if (!store) {
      throw new Error('updateTerminalSettings: window.__store is unavailable')
    }
    await store.getState().updateSettings(patch)
  }, patch)
}

async function waitForRetentionBudgetSetting(page: Page, enabled: boolean): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__store?.getState().settings?.terminalHiddenWorktreeRetentionBudget
        ),
      { timeout: 5_000, message: `terminalHiddenWorktreeRetentionBudget did not become ${enabled}` }
    )
    .toBe(enabled)
}

test.describe('Terminal hidden worktree retention budget', () => {
  test.use({
    orcaAppExtraEnv: {
      ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS),
      // Why limit=1: the retention TTL is absolute production timing (45min) and
      // the parking-delay override deliberately no longer shrinks it, so the
      // COUNT CAP is the only knob a test can drive. With a budget of 1 the
      // newest hidden un-parkable worktree takes the last-active exemption and
      // the older one force-parks — cap and exemption proven in one run.
      ORCA_E2E_TERMINAL_RETENTION_LIMIT: '1'
    },
    orcaAppExtraArgs: ['--enable-precise-memory-info']
  })

  test('releases un-parkable hidden worktree buffers only once the retention budget engages', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    test.setTimeout(RETENTION_TEST_TIMEOUT_MS)
    await waitForSessionReady(orcaPage)
    const victimWorktreeId = await waitForActiveWorktree(orcaPage)
    await skipUnlessParkingWired(orcaPage)

    const decoyWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (worktreeId) => worktreeId !== victimWorktreeId
    )
    if (!decoyWorktreeId) {
      throw new Error('retention budget spec: the fixture seeded only one worktree')
    }

    // Budget OFF for the whole staging phase: that is the control arm proving
    // ordinary parking can never evict this class, and it makes the release
    // below attributable to the flip alone.
    await updateTerminalSettings(orcaPage, {
      terminalHiddenWorktreeRetentionBudget: false,
      terminalScrollbackRows: RETENTION_SCROLLBACK_ROWS
    })
    await waitForRetentionBudgetSetting(orcaPage, false)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-retention-memory-${runId}.mjs`)
    writeScrollbackFillScript(scriptPath, runId, RETENTION_FILL_LINE_COUNT)
    try {
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const baselineSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      const baselinePtyId = baselineSnapshot.panes[0]?.ptyId
      if (!baselinePtyId) {
        throw new Error('retention budget spec: baseline terminal tab did not bind a PTY')
      }

      const victimTabs: ScrollbackTab[] = [{ tabId: baselineSnapshot.tabId, ptyId: baselinePtyId }]
      for (let tabIndex = 0; tabIndex < RETENTION_TAB_COUNT; tabIndex += 1) {
        if (tabIndex > 0) {
          victimTabs.push(await createActiveTerminalTab(orcaPage, victimWorktreeId))
        }
        const tab = victimTabs[tabIndex]
        await sendToTerminal(
          orcaPage,
          tab.ptyId,
          `node ${JSON.stringify(scriptPath)} ${tabIndex}\r`
        )
        await waitForFillMarkerInTab(
          orcaPage,
          tab.tabId,
          `PARKED_MEMORY_FILL_DONE_${runId}_${tabIndex}`
        )
        // Why stage after every fill rather than once at the end: each later
        // fill takes seconds, and ordinary TAB-level parking would evict the
        // already-hidden earlier tabs inside that window.
        await stageUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      }

      // Hiding the victim first makes the decoy the more-recently-hidden
      // candidate, so the cap's last-active exemption lands on the decoy.
      await switchToWorktree(orcaPage, decoyWorktreeId)
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId), {
          timeout: 5_000,
          message: 'decoy worktree did not become active before staging'
        })
        .toBe(decoyWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      // Why the active snapshot (not getWorktreeTabs alone): only tabs that
      // actually bound a PaneManager can prove retention; empty/deferred ids
      // would make the control arm look like a budget failure.
      const decoySnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      const decoyTabIds = [decoySnapshot.tabId]
      expect(await countMountedPaneManagers(orcaPage, decoyTabIds)).toBe(1)

      // Leaving the terminal view hides BOTH worktrees while keeping them
      // mounted (App.tsx hides the workbench, it does not unmount it).
      await orcaPage.evaluate(() => {
        window.__store?.getState().setActiveView('tasks')
      })
      // Why stage AFTER hide: while a pane is visible/active, bind can rewrite
      // our remote: fake ids back onto tab/layout state, so the decoy looks
      // park-restorable and ordinary parking unmounts it during the control
      // arm. Staging only once both are hidden keeps classification stable.
      await stageUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      await stageUnparkableWorktreeTabs(orcaPage, decoyWorktreeId)
      await waitForUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      await waitForUnparkableWorktreeTabs(orcaPage, decoyWorktreeId)

      const victimTabIds = victimTabs.map((tab) => tab.tabId)
      expect(victimTabIds).toHaveLength(RETENTION_TAB_COUNT)
      // Control arm: stay hidden past the ordinary parking window with budget
      // still off. Re-stage inside the poll so a late bind cannot restore
      // park-restorable+coverable ids and unmount mid-wait.
      const controlArmStartedAt = Date.now()
      await expect
        .poll(
          async () => {
            await stageUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
            await stageUnparkableWorktreeTabs(orcaPage, decoyWorktreeId)
            const victimMounted = await countMountedPaneManagers(orcaPage, victimTabIds)
            const decoyMounted = await countMountedPaneManagers(orcaPage, decoyTabIds)
            const heldLongEnough = Date.now() - controlArmStartedAt >= PARKING_DELAY_MS * 4
            return {
              victimMounted,
              decoyMounted,
              heldLongEnough
            }
          },
          {
            timeout: Math.max(30_000, PARKING_DELAY_MS * 10),
            message:
              'control arm: un-parkable hidden worktrees did not stay mounted for the parking window'
          }
        )
        .toEqual({
          victimMounted: RETENTION_TAB_COUNT,
          decoyMounted: 1,
          heldLongEnough: true
        })
      await waitForUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      await waitForUnparkableWorktreeTabs(orcaPage, decoyWorktreeId)

      const before = await readRetentionMemorySample(orcaPage)
      expect(before.bufferMb).toBeGreaterThan(MIN_STAGED_BUFFER_MB)

      const flipStartedAt = Date.now()
      await updateTerminalSettings(orcaPage, { terminalHiddenWorktreeRetentionBudget: true })
      await waitForRetentionBudgetSetting(orcaPage, true)
      await expect
        .poll(() => countMountedPaneManagers(orcaPage, victimTabIds), {
          timeout: 30_000,
          message: 'retention budget did not force-park the older hidden un-parkable worktree'
        })
        .toBe(0)
      const evictionMs = Date.now() - flipStartedAt

      const after = await readRetentionMemorySample(orcaPage)
      testInfo.annotations.push({
        type: 'terminal-retention-budget-memory',
        description: [
          `stagedTabs=${RETENTION_TAB_COUNT}`,
          `scrollbackRows=${RETENTION_SCROLLBACK_ROWS}`,
          formatRetentionSample('before', before),
          formatRetentionSample('after', after),
          `releasedBufferMB=${(before.bufferMb - after.bufferMb).toFixed(1)}`,
          `evictionMs=${evictionMs}`
        ].join(' ')
      })

      // Primary gate: the staged buffers are gone, not merely hidden.
      expect(after.buffers.cells).toBeLessThan(before.buffers.cells * MAX_RETAINED_CELL_FRACTION)
      // The decoy holds the cap's last-active exemption, so it stays mounted —
      // this is the same run proving the cap did not simply evict everything.
      expect(await countMountedPaneManagers(orcaPage, decoyTabIds)).toBe(decoyTabIds.length)
      // Secondary only: freed typed arrays return to the allocator's free lists,
      // not the OS, so RSS fell just 0.7-3.0 MB locally while 87 MB of buffer was
      // released — a strict non-growth assertion would be reading sampling noise.
      // What this CAN catch is the inverse regression the capture path risks:
      // force-park planting serialized scrollback in the store as it evicts.
      if (before.rendererMb !== null && after.rendererMb !== null) {
        expect(after.rendererMb).toBeLessThanOrEqual(before.rendererMb + RENDERER_RSS_NOISE_MB)
      }
      expect(evictionMs).toBeLessThan(MAX_FORCE_PARK_EVICTION_MS)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
