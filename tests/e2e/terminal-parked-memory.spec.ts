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

// Scope fast-park overrides to these launches to avoid leaking past the spec; production cold delay is 30s.
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) },
  // Disable Chromium memory quantization/~20min refresh so samples do not reuse the launch-time bucket.
  orcaAppExtraArgs: ['--enable-precise-memory-info']
})

// Fast-park overrides collapse hot retention to cold delay, parking 7/8 hidden tabs before retain-count policy.
// Only the most-recently-hidden last-active tab remains exempt.
const SCROLLBACK_TAB_COUNT = 8
const SCROLLBACK_LINE_COUNT = 3000
const PARK_SETTLE_MS = 2_000
const HEAP_SAMPLE_COUNT = 5
const HEAP_SAMPLE_INTERVAL_MS = 250
// Fresh app plus eight ~3000-line fills and parking exceeds the default 120s test budget.
const PARKED_MEMORY_TEST_TIMEOUT_MS = 300_000

// Use ASCII, CJK, emoji and boxes so released narrow/wide buffer storage resembles agent output.
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

// Skip builds without parking’s debug handle for merge-order compatibility.
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

// Unmount removes window.__paneManagers entries, exposing actual view parking.
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

// Expect the last-filled hidden tab to remain mounted under last-active exemption.
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

// Fill while visible so hidden-delivery drops cannot remove the scrollback used for memory comparison.
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

// Take the minimum of settled best-effort CDP-GC samples to reduce allocation noise.
// xterm typed-array rows live outside V8 heap; terminal/manager counts are the strong release signal, heap tracks only on-heap ownership.
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

      // The ninth tab hides all eight fills; the last filled keeps the warm exemption and seven park.
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

      for (const tab of parkableTabs) {
        expect((await readTerminalTabViewState(orcaPage, tab.tabId)).hasManager).toBe(false)
      }
      expect((await readTerminalTabViewState(orcaPage, lastActiveTab.tabId)).hasManager).toBe(true)
      const visibleState = await readTerminalTabViewState(orcaPage, visibleTab.tabId)
      expect(visibleState.hasManager).toBe(true)
      expect(visibleState.paneCount).toBeGreaterThan(0)
      // Require only visible plus last-active xterm/manager ownership; all other views must park.
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

    // Flip the persisted parking kill switch through updateSettings, the same subscribed mutation path as production.
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
      // Enabled parking already proved this build’s machinery; surviving 3× delay demonstrates the kill switch.
      await orcaPage.waitForTimeout(PARKING_DELAY_MS * 3)
      expect(await countMountedPaneManagers(orcaPage, scrollbackTabIds)).toBe(SCROLLBACK_TAB_COUNT)

      const metrics = await sampleParkedMemoryMetrics(orcaPage)
      testInfo.annotations.push({
        type: 'opencode-parked-memory-disabled',
        description: formatParkedMemoryAnnotation(metrics, 0)
      })

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

// Measure retention-budget release for hidden worktrees ordinary parking cannot evict, changing only the budget.
// Proxy remote eligibility with remote-shaped tab.ptyId while retaining real LOCAL transports; this is not live remote-runtime coverage.
// Gate retained buffer cells; typed arrays evade V8 heap and RSS follows allocator/GC/compositor noise, so RSS uses a tolerance band.
const RETENTION_TAB_COUNT = 4
const RETENTION_FILL_LINE_COUNT = 12_000
const RETENTION_SCROLLBACK_ROWS = 25_000
// Why 12: xterm packs each cell as 3 uint32s in the BufferLine typed array.
const XTERM_BYTES_PER_CELL = 12
// Require >40MB from the ~87MB staged baseline so a missing fill cannot pass.
const MIN_STAGED_BUFFER_MB = 40
// Setting flip force-parks synchronously (~23–25ms locally); 2s rejects timer/TTL dependence.
const MAX_FORCE_PARK_EVICTION_MS = 2_000
// Only the unfilled exempt decoy (~0.1%) may remain; one filled pane (~25%) must fail.
const MAX_RETAINED_CELL_FRACTION = 0.05
// Allow 5MB RSS noise (observed release 0.7–3MB at ~453MB baseline), while rejecting 512KB/pane capture strings.
const RENDERER_RSS_NOISE_MB = 5
const RETENTION_TEST_TIMEOUT_MS = 420_000
const UNPARKABLE_PTY_PREFIX = 'remote:e2e-retention-'

type RetainedBufferSample = {
  cells: number
  rows: number
  panes: number
}

// Count typed-array buffer cells directly; heap deltas miss this storage.
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

// Sample renderer process RSS, the C1 crash-report quantity performance.memory cannot see.
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

// Rewrite only tab.ptyId for canPark eligibility; keep leaf maps on local transports so panes stay bound even if watchers read locals.
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

// Re-stage inside polling because late bind/reconcile can restore parkable local ids.
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

// Scan only the fill marker in the tail; full-scroll serialization allocates megabytes per poll.
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
      // Use count cap 1: production 45min TTL is not shortened by parking overrides.
      // The newer hidden unparkable worktree gets last-active exemption; the older must force-park.
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

    // Keep budget off through staging/control so release is attributable only to the setting flip.
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
        // Re-stage after each slow fill; otherwise ordinary tab parking can evict earlier hidden tabs.
        await stageUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      }

      // Hide the victim first so the later-hidden decoy takes last-active exemption.
      await switchToWorktree(orcaPage, decoyWorktreeId)
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId), {
          timeout: 5_000,
          message: 'decoy worktree did not become active before staging'
        })
        .toBe(decoyWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      // Require active PaneManager-bound snapshots; empty/deferred ids cannot demonstrate retention.
      const decoySnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      const decoyTabIds = [decoySnapshot.tabId]
      expect(await countMountedPaneManagers(orcaPage, decoyTabIds)).toBe(1)

      // Leave terminal view to hide both worktrees while App keeps the workbench mounted.
      await orcaPage.evaluate(() => {
        window.__store?.getState().setActiveView('tasks')
      })
      // Stage after hiding: visible-pane binds can replace fake remote ids and let ordinary parking evict during control.
      await stageUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      await stageUnparkableWorktreeTabs(orcaPage, decoyWorktreeId)
      await waitForUnparkableWorktreeTabs(orcaPage, victimWorktreeId)
      await waitForUnparkableWorktreeTabs(orcaPage, decoyWorktreeId)

      const victimTabIds = victimTabs.map((tab) => tab.tabId)
      expect(victimTabIds).toHaveLength(RETENTION_TAB_COUNT)
      // Keep budget off past the ordinary parking window, re-staging against late bind classification changes.
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

      expect(after.buffers.cells).toBeLessThan(before.buffers.cells * MAX_RETAINED_CELL_FRACTION)
      // Require the last-active decoy to survive so the cap cannot pass by evicting everything.
      expect(await countMountedPaneManagers(orcaPage, decoyTabIds)).toBe(decoyTabIds.length)
      // Typed arrays return to allocator free lists, so RSS may barely fall despite ~87MB released.
      // Tolerate sampling noise while catching eviction that plants serialized scrollback in the store.
      if (before.rendererMb !== null && after.rendererMb !== null) {
        expect(after.rendererMb).toBeLessThanOrEqual(before.rendererMb + RENDERER_RSS_NOISE_MB)
      }
      expect(evictionMs).toBeLessThan(MAX_FORCE_PARK_EVICTION_MS)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
