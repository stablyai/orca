import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  countVisibleTerminalPanes,
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  buildBenchmarkReport,
  type BenchmarkRevisionIdentity,
  type BrowserWindowState,
  type TerminalSplitLatencyReportConfig
} from './terminal-split-activation-latency-report'
import {
  sanitizeTerminalSplitLatencyReport,
  writeTerminalSplitLatencyArtifact
} from './terminal-split-activation-latency-artifact'
import {
  disposeSplitLatencyMainProbe,
  installSplitLatencyMainProbe,
  readSplitLatencyMainProbe,
  resetSplitLatencyMainProbe
} from './terminal-split-activation-latency-main-probe'
import {
  createSplitLatencySample,
  mergeSplitLatencyMainProbeEvents,
  type RendererPhaseStamps,
  type SplitLatencySample
} from './terminal-split-activation-latency-phases'

const BENCH_ENABLED = process.env.ORCA_TERMINAL_SPLIT_LATENCY_BENCH === '1'
const BENCH_LABEL = process.env.ORCA_TERMINAL_SPLIT_LATENCY_LABEL?.trim() || 'local'
const BENCH_OUTPUT_PATH = process.env.ORCA_TERMINAL_SPLIT_LATENCY_OUTPUT?.trim() || null
const WARMUP_CYCLES = 3
const MIN_MEASURED_CYCLES = 20
const MAX_MEASURED_CYCLES = 200
const SAMPLE_TIMEOUT_MS = 15_000
const CLEANUP_TIMEOUT_MS = 15_000
const CONFIRM_CLICK_TIMEOUT_MS = 2_000
const BENCH_SETUP_TIMEOUT_MS = 5 * 60 * 1000
// Why: process-cwd caches each pid for 1500ms; this wait isolates cold lookups, not correctness.
const PROCESS_CWD_CACHE_EXPIRY_WAIT_MS = 1_650
const SOURCE_READY_MARKER = 'ORCA_SPLIT_LATENCY_SOURCE_READY'
const IS_MAC = process.platform === 'darwin'
const SPLIT_CHORD = IS_MAC ? 'Meta+d' : 'Control+Shift+d'
const CLOSE_CHORD = IS_MAC ? 'Meta+w' : 'Control+w'

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const MEASURED_CYCLES = Math.min(
  MAX_MEASURED_CYCLES,
  Math.max(
    MIN_MEASURED_CYCLES,
    readPositiveInt('ORCA_TERMINAL_SPLIT_LATENCY_CYCLES', MIN_MEASURED_CYCLES)
  )
)
const BENCH_TIMEOUT_MS =
  BENCH_SETUP_TIMEOUT_MS +
  WARMUP_CYCLES * (SAMPLE_TIMEOUT_MS + 4 * CLEANUP_TIMEOUT_MS + CONFIRM_CLICK_TIMEOUT_MS) +
  MEASURED_CYCLES *
    (SAMPLE_TIMEOUT_MS +
      4 * CLEANUP_TIMEOUT_MS +
      CONFIRM_CLICK_TIMEOUT_MS +
      PROCESS_CWD_CACHE_EXPIRY_WAIT_MS)
const REPORT_CONFIG = {
  warmupCycles: WARMUP_CYCLES,
  measuredCycles: MEASURED_CYCLES,
  maxMeasuredCycles: MAX_MEASURED_CYCLES,
  testTimeoutMs: BENCH_TIMEOUT_MS,
  splitChord: SPLIT_CHORD,
  closeChord: CLOSE_CHORD,
  sampleTimeoutMs: SAMPLE_TIMEOUT_MS,
  cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
  processCwdCacheExpiryWaitMs: PROCESS_CWD_CACHE_EXPIRY_WAIT_MS
} satisfies TerminalSplitLatencyReportConfig

type RendererProbe = {
  report: () => RendererPhaseStamps
  dispose: () => void
}

type SplitLatencyProbeWindow = Window & {
  __terminalSplitLatencyProbe?: RendererProbe
  __terminalSplitLatencyPtyExitIds?: string[]
  __terminalSplitLatencyPtyExitDispose?: () => void
}

function readBenchmarkRevisionIdentity(): BenchmarkRevisionIdentity {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  }).trim()
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`Unable to resolve exact benchmark revision: ${headSha || 'empty output'}`)
  }
  const dirty =
    execFileSync('git', ['status', '--porcelain'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    }).trim().length > 0
  return { headSha, dirty }
}

function createEchoShellFixture(): { root: string; shellPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-split-latency-'))
  const shellPath = path.join(root, 'split-echo-shell')
  writeFileSync(
    shellPath,
    [
      '#!/bin/sh',
      'stty raw -echo',
      'dd bs=1 count=1 of=/dev/null 2>/dev/null',
      `printf '%s' '${SOURCE_READY_MARKER}'`,
      'exec /bin/cat',
      ''
    ].join('\n'),
    'utf8'
  )
  chmodSync(shellPath, 0o755)
  return { root, shellPath }
}

async function createSourceTab(
  page: Page,
  shellOverride: string
): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await page.evaluate((shellOverride) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    const tab = state.createTab(worktreeId, undefined, shellOverride, { activate: true })
    store.getState().setActiveTab(tab.id)
    store.getState().setActiveTabType('terminal')
    return tab.id
  }, shellOverride)

  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  await sendToTerminal(page, ptyId, '\r')
  await waitForTerminalOutput(page, SOURCE_READY_MARKER, 30_000)
  return { tabId, ptyId }
}

async function readActivePaneId(page: Page, tabId: string): Promise<number> {
  const paneId = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    return manager?.getActivePane?.()?.id ?? null
  }, tabId)
  if (paneId === null) {
    throw new Error(`No active pane for source tab ${tabId}`)
  }
  return paneId
}

async function installRendererProbe(
  page: Page,
  args: {
    tabId: string
    sourcePaneId: number
    sourcePtyId: string
    marker: string
    readyMarker: string
    isMac: boolean
  }
): Promise<void> {
  await page.evaluate(({ tabId, sourcePaneId, sourcePtyId, marker, readyMarker, isMac }) => {
    const targetWindow = window as SplitLatencyProbeWindow
    targetWindow.__terminalSplitLatencyProbe?.dispose()

    const stamps: RendererPhaseStamps = {
      marker,
      sourcePaneId,
      sourcePtyId,
      newPaneId: null,
      newPtyId: null,
      rendererTimeOriginEpochMs: performance.timeOrigin,
      keydownAtMs: null,
      focusAtMs: null,
      cwdRequestAtMs: null,
      cwdSettledAtMs: null,
      ptySpawnRequestAtMs: null,
      ptySpawnResultAtMs: null,
      ptyBoundAtMs: null,
      fixtureUnlockRequestedAtMs: null,
      fixtureUnlockIpcWriteAtMs: null,
      fixtureUnlockIpcWriteChannel: null,
      fixtureReadyParsedAtMs: null,
      inputAtMs: null,
      firstEchoAtMs: null
    }
    let ptyBindingObserver: MutationObserver | null = null
    let parsedDisposable: { dispose: () => void } | null = null
    let fixtureReady = false
    let markerFeedQueued = false
    const originalStopImmediatePropagation = Event.prototype.stopImmediatePropagation

    const onKeyDown = (event: KeyboardEvent): void => {
      const matches = isMac
        ? event.code === 'KeyD' && event.metaKey && !event.shiftKey && !event.altKey
        : event.code === 'KeyD' && event.ctrlKey && event.shiftKey && !event.altKey
      if (matches && stamps.keydownAtMs === null) {
        stamps.keydownAtMs = performance.now()
      }
    }
    const patchedStopImmediatePropagation = function (this: Event): void {
      // Why: terminal shortcuts stop same-target listeners before split work starts.
      if (this instanceof KeyboardEvent) {
        onKeyDown(this)
      }
      originalStopImmediatePropagation.call(this)
    }

    const onFocusIn = (event: FocusEvent): void => {
      if (stamps.keydownAtMs === null || stamps.focusAtMs !== null) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches('.xterm-helper-textarea')) {
        return
      }
      const paneElement = target.closest<HTMLElement>('.pane[data-pane-id]')
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getPanes?.().find((candidate) => candidate.container === paneElement)
      if (!pane || pane.id === sourcePaneId) {
        return
      }

      stamps.newPaneId = pane.id
      stamps.focusAtMs = performance.now()
      const maybeFeedMarker = (): void => {
        if (!fixtureReady || stamps.ptyBoundAtMs === null || markerFeedQueued) {
          return
        }
        markerFeedQueued = true
        queueMicrotask(() => {
          stamps.inputAtMs = performance.now()
          pane.terminal.input(marker, true)
        })
      }
      const observeParsedOutput = (): void => {
        const buffer = pane.terminal.buffer.active
        let text = ''
        for (let row = 0; row < buffer.length; row += 1) {
          text += buffer.getLine(row)?.translateToString(true) ?? ''
        }
        if (!fixtureReady && text.includes(readyMarker)) {
          fixtureReady = true
          stamps.fixtureReadyParsedAtMs = performance.now()
          maybeFeedMarker()
        }
        if (stamps.firstEchoAtMs === null && text.includes(marker)) {
          stamps.firstEchoAtMs = performance.now()
        }
      }
      parsedDisposable = pane.terminal.onWriteParsed(observeParsedOutput)
      observeParsedOutput()

      const observePtyBinding = (): void => {
        const ptyId = pane.container.dataset.ptyId
        if (!ptyId || stamps.ptyBoundAtMs !== null) {
          return
        }
        stamps.newPtyId = ptyId
        stamps.ptyBoundAtMs = performance.now()
        ptyBindingObserver?.disconnect()
        queueMicrotask(() => {
          stamps.fixtureUnlockRequestedAtMs = performance.now()
          pane.terminal.input('\r', true)
        })
      }

      if (pane.container.dataset.ptyId) {
        observePtyBinding()
        return
      }
      ptyBindingObserver = new MutationObserver(observePtyBinding)
      ptyBindingObserver.observe(pane.container, {
        attributes: true,
        attributeFilter: ['data-pty-id']
      })
    }

    Event.prototype.stopImmediatePropagation = patchedStopImmediatePropagation
    window.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('focusin', onFocusIn, { capture: true })
    targetWindow.__terminalSplitLatencyProbe = {
      report: () => ({ ...stamps }),
      dispose: () => {
        window.removeEventListener('keydown', onKeyDown, { capture: true })
        document.removeEventListener('focusin', onFocusIn, { capture: true })
        if (Event.prototype.stopImmediatePropagation === patchedStopImmediatePropagation) {
          Event.prototype.stopImmediatePropagation = originalStopImmediatePropagation
        }
        ptyBindingObserver?.disconnect()
        parsedDisposable?.dispose()
      }
    }
  }, args)
}

async function waitForRendererProbe(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(
      () =>
        (window as SplitLatencyProbeWindow).__terminalSplitLatencyProbe?.report().firstEchoAtMs !==
        null,
      null,
      { timeout: SAMPLE_TIMEOUT_MS }
    )
    return true
  } catch {
    return false
  }
}

async function collectRendererProbe(page: Page): Promise<RendererPhaseStamps> {
  return page.evaluate(() => {
    const targetWindow = window as SplitLatencyProbeWindow
    const probe = targetWindow.__terminalSplitLatencyProbe
    if (!probe) {
      throw new Error('Terminal split latency probe was not installed')
    }
    const report = probe.report()
    probe.dispose()
    delete targetWindow.__terminalSplitLatencyProbe
    return report
  })
}

async function closeSplitsAndRefocusSource(
  page: Page,
  tabId: string,
  sourcePaneId: number,
  closedPtyIds: string[]
): Promise<{ closeCompletedAt: number; ptyExitObserved: boolean; cleanupError: string | null }> {
  let paneCount = await countVisibleTerminalPanes(page)
  if (paneCount < 1) {
    throw new Error('Source terminal disappeared during split benchmark')
  }
  while (paneCount > 1) {
    const expectedCount = paneCount - 1
    await focusActiveTerminalInput(page)
    await page.keyboard.press(CLOSE_CHORD)
    const confirmButton = page
      .locator(
        '[data-slot="dialog-content"][data-state="open"] [data-slot="dialog-footer"] [data-slot="button"][data-variant="destructive"]'
      )
      .last()
    await expect
      .poll(
        async () => {
          if (await confirmButton.isVisible().catch(() => false)) {
            await confirmButton.click({ timeout: CONFIRM_CLICK_TIMEOUT_MS })
          }
          return countVisibleTerminalPanes(page)
        },
        {
          timeout: CLEANUP_TIMEOUT_MS,
          message: `Split pane did not close to ${expectedCount} pane(s)`
        }
      )
      .toBe(expectedCount)
    paneCount = expectedCount
  }
  await waitForPaneCount(page, 1, CLEANUP_TIMEOUT_MS)
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ tabId, sourcePaneId }) =>
            window.__paneManagers?.get(tabId)?.getActivePane?.()?.id === sourcePaneId,
          { tabId, sourcePaneId }
        ),
      {
        timeout: CLEANUP_TIMEOUT_MS,
        message: 'Source pane did not regain active ownership after close'
      }
    )
    .toBe(true)
  const ptyExitResults = await Promise.all(
    closedPtyIds.map(async (ptyId) => ({ ptyId, observed: await waitForPtyExit(page, ptyId) }))
  )
  const missingPtyExitIds = ptyExitResults
    .filter((result) => !result.observed)
    .map((result) => result.ptyId)
  await focusActiveTerminalInput(page)
  const cleanupError =
    closedPtyIds.length === 0
      ? 'Split cleanup could not identify a child PTY to verify its exit'
      : missingPtyExitIds.length > 0
        ? `Closed split PTY did not emit exit: ${missingPtyExitIds.join(', ')}`
        : null
  return {
    closeCompletedAt: Date.now(),
    ptyExitObserved: cleanupError === null,
    cleanupError
  }
}

async function readChildPtyIds(page: Page, tabId: string, sourcePtyId: string): Promise<string[]> {
  return page.evaluate(
    ({ tabId, sourcePtyId }) => {
      const manager = window.__paneManagers?.get(tabId)
      return (manager?.getPanes?.() ?? [])
        .map((pane) => pane.container.dataset.ptyId ?? null)
        .filter((ptyId): ptyId is string => Boolean(ptyId) && ptyId !== sourcePtyId)
    },
    { tabId, sourcePtyId }
  )
}

async function runSplitCycle(
  electronApp: ElectronApplication,
  page: Page,
  args: {
    tabId: string
    sourcePaneId: number
    sourcePtyId: string
    phase: SplitLatencySample['phase']
    iteration: number
  }
): Promise<{ sample: SplitLatencySample; closeCompletedAt: number; fatalError: Error | null }> {
  const marker = `ORCA_SPLIT_ECHO_${args.phase}_${args.iteration}_${randomUUID().replaceAll('-', '')}`
  await focusActiveTerminalInput(page)
  // Prevent an ID reused by a later PTY lifetime from matching an earlier exit.
  await resetPtyExitProbe(page)
  await resetSplitLatencyMainProbe(electronApp)
  await installRendererProbe(page, {
    tabId: args.tabId,
    sourcePaneId: args.sourcePaneId,
    sourcePtyId: args.sourcePtyId,
    marker,
    readyMarker: SOURCE_READY_MARKER,
    isMac: IS_MAC
  })
  await page.keyboard.press(SPLIT_CHORD)
  const completedWithinTimeout = await waitForRendererProbe(page)
  const rendererStamps = await collectRendererProbe(page)
  const stamps = mergeSplitLatencyMainProbeEvents(
    rendererStamps,
    await readSplitLatencyMainProbe(electronApp)
  )
  let paneCountAfterProbe = -1
  let closeCompletedAt = Date.now()
  let ptyExitObserved = false
  let cleanupError: Error | null = null
  try {
    paneCountAfterProbe = await countVisibleTerminalPanes(page)
    const childPtyIds = await readChildPtyIds(page, args.tabId, args.sourcePtyId)
    const closeResult = await closeSplitsAndRefocusSource(
      page,
      args.tabId,
      args.sourcePaneId,
      childPtyIds
    )
    closeCompletedAt = closeResult.closeCompletedAt
    ptyExitObserved = closeResult.ptyExitObserved
    cleanupError = closeResult.cleanupError ? new Error(closeResult.cleanupError) : null
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error))
    closeCompletedAt = Date.now()
  }
  const sample = createSplitLatencySample({
    phase: args.phase,
    iteration: args.iteration,
    stamps,
    completedWithinTimeout,
    paneCountAfterProbe,
    ptyExitObserved,
    cleanupError: cleanupError?.message ?? null
  })
  return { sample, closeCompletedAt, fatalError: cleanupError }
}

async function waitForColdProcessCwdLookup(
  page: Page,
  priorCloseCompletedAt: number
): Promise<void> {
  const remaining = PROCESS_CWD_CACHE_EXPIRY_WAIT_MS - (Date.now() - priorCloseCompletedAt)
  if (remaining > 0) {
    await page.waitForTimeout(remaining)
  }
  expect(Date.now() - priorCloseCompletedAt).toBeGreaterThanOrEqual(
    PROCESS_CWD_CACHE_EXPIRY_WAIT_MS
  )
}

function logSample(sample: SplitLatencySample): void {
  console.log(
    `[terminal-split-activation-latency] ${sample.phase} ${sample.iteration + 1} ` +
      `success=${sample.success} missing=${sample.missing.join(',') || 'none'}`
  )
}

async function installPtyExitProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as SplitLatencyProbeWindow
    targetWindow.__terminalSplitLatencyPtyExitDispose?.()
    targetWindow.__terminalSplitLatencyPtyExitIds = []
    targetWindow.__terminalSplitLatencyPtyExitDispose = window.api.pty.onExit(({ id }) => {
      const ids = targetWindow.__terminalSplitLatencyPtyExitIds ?? []
      if (!ids.includes(id)) {
        ids.push(id)
      }
      targetWindow.__terminalSplitLatencyPtyExitIds = ids
    })
  })
}

async function resetPtyExitProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as SplitLatencyProbeWindow).__terminalSplitLatencyPtyExitIds = []
  })
}

async function waitForPtyExit(page: Page, ptyId: string): Promise<boolean> {
  try {
    await expect
      .poll(
        () =>
          page.evaluate((expectedPtyId) => {
            const targetWindow = window as SplitLatencyProbeWindow
            return targetWindow.__terminalSplitLatencyPtyExitIds?.includes(expectedPtyId) ?? false
          }, ptyId),
        { timeout: CLEANUP_TIMEOUT_MS, message: `Closed split PTY did not emit exit: ${ptyId}` }
      )
      .toBe(true)
    return true
  } catch {
    return false
  }
}

async function disposePtyExitProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as SplitLatencyProbeWindow
    targetWindow.__terminalSplitLatencyPtyExitDispose?.()
    delete targetWindow.__terminalSplitLatencyPtyExitDispose
    delete targetWindow.__terminalSplitLatencyPtyExitIds
  })
}

async function attachReport(testInfo: TestInfo, report: Record<string, unknown>): Promise<void> {
  const body = `${JSON.stringify(sanitizeTerminalSplitLatencyReport(report), null, 2)}\n`
  await testInfo.attach('terminal-split-activation-latency.json', {
    body,
    contentType: 'application/json'
  })
  if (BENCH_OUTPUT_PATH) {
    writeTerminalSplitLatencyArtifact(BENCH_OUTPUT_PATH, body)
  }
  console.log(
    `[terminal-split-activation-latency] ${JSON.stringify(sanitizeTerminalSplitLatencyReport(report))}`
  )
}

test.describe('Terminal split activation latency benchmark @headful', () => {
  test.skip(!BENCH_ENABLED, 'One-off benchmark: set ORCA_TERMINAL_SPLIT_LATENCY_BENCH=1')
  test.skip(process.platform === 'win32', 'Deterministic echo-shell fixture is POSIX-only')
  test.setTimeout(BENCH_TIMEOUT_MS)

  test('records attributed CWD, spawn, bind, fixture-ready, input, and echo phases', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const headfulRun =
      process.env.ORCA_E2E_FORCE_HEADFUL === '1' || testInfo.project.metadata.orcaHeadful === true
    const windowState: BrowserWindowState = {
      browserWindowVisible: false,
      windowCount: 0
    }
    let documentVisibility = 'unavailable'
    let fixture: { root: string; shellPath: string } | null = null
    const warmupSamples: SplitLatencySample[] = []
    const measuredSamples: SplitLatencySample[] = []
    let revision: BenchmarkRevisionIdentity = { headSha: 'unavailable', dirty: true }
    let abortError: Error | null = null
    let reportAttached = false
    try {
      revision = readBenchmarkRevisionIdentity()
      expect(headfulRun, 'The latency benchmark must run with a visible BrowserWindow').toBe(true)
      const observedWindowState = await electronApp.evaluate(({ BrowserWindow }) => ({
        browserWindowVisible: BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
        windowCount: BrowserWindow.getAllWindows().length
      }))
      windowState.browserWindowVisible = observedWindowState.browserWindowVisible
      windowState.windowCount = observedWindowState.windowCount
      expect(windowState.windowCount).toBeGreaterThan(0)
      expect(windowState.browserWindowVisible).toBe(true)
      await expect
        .poll(
          async () => {
            documentVisibility = await orcaPage.evaluate(() => document.visibilityState)
            return documentVisibility
          },
          {
            timeout: 15_000,
            message: 'Visible latency benchmark renderer remained hidden'
          }
        )
        .toBe('visible')
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)

      fixture = createEchoShellFixture()
      const source = await createSourceTab(orcaPage, fixture.shellPath)
      const { tabId, ptyId: sourcePtyId } = source
      const sourcePaneId = await readActivePaneId(orcaPage, tabId)
      await installPtyExitProbe(orcaPage)
      await installSplitLatencyMainProbe(electronApp)
      let priorCloseCompletedAt = Date.now()

      for (let iteration = 0; iteration < WARMUP_CYCLES; iteration += 1) {
        const result = await runSplitCycle(electronApp, orcaPage, {
          tabId,
          sourcePaneId,
          sourcePtyId,
          phase: 'warmup',
          iteration
        })
        warmupSamples.push(result.sample)
        logSample(result.sample)
        priorCloseCompletedAt = result.closeCompletedAt
        if (result.fatalError) {
          abortError = result.fatalError
          break
        }
      }

      for (let iteration = 0; iteration < MEASURED_CYCLES && abortError === null; iteration += 1) {
        await waitForColdProcessCwdLookup(orcaPage, priorCloseCompletedAt)
        const result = await runSplitCycle(electronApp, orcaPage, {
          tabId,
          sourcePaneId,
          sourcePtyId,
          phase: 'measured',
          iteration
        })
        measuredSamples.push(result.sample)
        logSample(result.sample)
        priorCloseCompletedAt = result.closeCompletedAt
        if (result.fatalError) {
          abortError = result.fatalError
        }
      }

      documentVisibility = await orcaPage
        .evaluate(() => document.visibilityState)
        .catch(() => 'unavailable' as const)
      const reportResult = buildBenchmarkReport({
        label: BENCH_LABEL,
        revision,
        headfulRun,
        windowState,
        documentVisibility,
        testRepoPath,
        warmupSamples,
        measuredSamples,
        abortError,
        config: REPORT_CONFIG
      })
      await attachReport(testInfo, reportResult.report)
      reportAttached = true
      testInfo.annotations.push({
        type: 'terminal-split-activation-latency',
        description:
          `success=${reportResult.measuredSummary.counts.success}/${MEASURED_CYCLES} ` +
          `focusP50=${reportResult.measuredSummary.distributions.shortcutToFocusMs.p50.toFixed(1)}ms ` +
          `echoP50=${reportResult.measuredSummary.distributions.shortcutToFirstEchoMs.p50.toFixed(1)}ms`
      })
      if (abortError) {
        throw abortError
      }
      expect(reportResult.warmupSummary.counts.success).toBe(WARMUP_CYCLES)
      expect(reportResult.measuredSummary.counts.success).toBe(MEASURED_CYCLES)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!reportAttached) {
        abortError ??= failure
        const failureReport = buildBenchmarkReport({
          label: BENCH_LABEL,
          revision,
          headfulRun,
          windowState,
          documentVisibility,
          testRepoPath,
          warmupSamples,
          measuredSamples,
          abortError,
          config: REPORT_CONFIG
        })
        await attachReport(testInfo, failureReport.report).catch((attachError) => {
          const message = attachError instanceof Error ? attachError.message : String(attachError)
          console.error(
            `[terminal-split-activation-latency] unable to attach failure report: ${message}`
          )
        })
      }
      throw error
    } finally {
      await disposeSplitLatencyMainProbe(electronApp).catch(() => undefined)
      await disposePtyExitProbe(orcaPage).catch(() => undefined)
      if (fixture) {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })
})
