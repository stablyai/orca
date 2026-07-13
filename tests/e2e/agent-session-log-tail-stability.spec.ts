import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

const ANCHOR_TOKEN = 'E2E_LIVE_LOG_STABLE_ANCHOR'
const INITIAL_PAYLOAD_BYTES = 9 * 1024 * 1024
const APPEND_CADENCE_MS = 5_000
const SETTLEMENT_MS = 500
// Why: peak deltas are single pre-GC samples, so they swing with runner GC
// timing on OS-level counters; allow the same ~20MB noise floor the settled
// retention budget already tolerates before the append-vs-replace ordering fails.
const PEAK_MEMORY_NOISE_ALLOWANCE_MB = 25

type CrashProbe = { processGone: { reason: string; exitCode: number } | null }
type MemorySample = {
  jsHeapMb: number
  privateMb: number
  workingSetMb: number
}

declare global {
  // eslint-disable-next-line no-var -- main-process global probe for this spec
  var __liveLogCrashProbe: CrashProbe | undefined
}

test.describe('Agent Session History live log', () => {
  test.use({
    orcaAppExtraArgs: ['--js-flags=--expose-gc', '--enable-precise-memory-info']
  })

  test('keeps a long View Log viewport stable while the transcript grows', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.setTimeout(10 * 60_000)
    const fixture = await seedSyntheticSession(electronApp, testRepoPath)
    await armMainProcessCrashProbe(electronApp)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
    })

    await orcaPage.setViewportSize({ width: 520, height: 720 })
    await openSessionHistory(orcaPage)
    const title = orcaPage.getByText(fixture.title, { exact: true }).first()
    await expect(title).toBeVisible({ timeout: 30_000 })
    await title.click()
    await orcaPage.getByText('View Log', { exact: true }).click()
    await expect
      .poll(() => readProbeOrNull(orcaPage), { timeout: 120_000 })
      .toMatchObject({ filePath: fixture.filePath, valueLength: fixture.initialLength })
    await orcaPage.setViewportSize({ width: 900, height: 720 })
    await orcaPage.evaluate(async () => {
      const state = window.__store?.getState()
      state?.setRightSidebarOpen(false)
      state?.setEditorFontZoomLevel(0)
      await state?.updateSettings({ terminalFontSize: 13 })
    })

    let baseline = await restoreAnchorState(orcaPage, true)
    console.log(`[live-log-stability] geometry ${JSON.stringify(baseline)}`)
    // Why: containment is proven by the full 9 MiB model length, which is
    // font-independent. Word-wrap pixel geometry varies ~10% across runner font
    // metrics (macOS baseline 2,775,880px; Linux CI ~2,498,292px), so keep only a
    // generous content-height floor as a collapsed/truncated-render smoke check.
    expect(baseline.valueLength).toBe(fixture.initialLength)
    expect(baseline.contentHeight).toBeGreaterThanOrEqual(2_000_000)
    expect(baseline.visibleRanges.length).toBeGreaterThan(0)
    expect(baseline.find).toMatchObject({ open: true, query: ANCHOR_TOKEN })
    expect(baseline.find.activeMatch).not.toBe('')

    const suffixMemory: { before: MemorySample; after: MemorySample; settled: MemorySample }[] = []
    const replacementMemory: {
      before: MemorySample
      after: MemorySample
      settled: MemorySample
    }[] = []

    for (let batch = 0; batch < 3; batch++) {
      const equivalentState = baseline
      replacementMemory.push(await measureLegacyControl(electronApp, orcaPage, baseline, batch))
      baseline = await restoreAnchorState(orcaPage, baseline.find.open, equivalentState.scrollTop)
      expect(baseline.contentHeight).toBe(equivalentState.contentHeight)
      expect(baseline.valueLength).toBe(equivalentState.valueLength)
      expect(baseline.valueTail).toBe(equivalentState.valueTail)
      expect(baseline.visibleRanges).toEqual(equivalentState.visibleRanges)
      expect(baseline.selection).toEqual(equivalentState.selection)
      expect(baseline.find).toEqual(equivalentState.find)
      expect(Math.abs(baseline.scrollTop - equivalentState.scrollTop)).toBeLessThanOrEqual(2)
      const suffix = `${JSON.stringify({ type: 'e2e_append', batch, text: 'tail-only' })}\n`
      await forceGcAndSettle(orcaPage)
      const before = await readMemory(electronApp, orcaPage)
      appendFileSync(fixture.filePath, suffix)
      fixture.initialLength += suffix.length
      await orcaPage.waitForTimeout(APPEND_CADENCE_MS)
      await expect
        .poll(() => readProbe(orcaPage), { timeout: 30_000 })
        .toMatchObject({ valueLength: fixture.initialLength })
      const after = await readMemory(electronApp, orcaPage)
      await forceGcAndSettle(orcaPage)
      const settled = await readMemory(electronApp, orcaPage)
      suffixMemory.push({ before, after, settled })
      const current = await readProbe(orcaPage)
      console.log(`[live-log-stability] anchor ${JSON.stringify({ batch, baseline, current })}`)
      expect(current.visibleRanges).toEqual(baseline.visibleRanges)
      expect(current.valueTail).toBe(suffix.trimEnd())
      expect(current.selection).toEqual(baseline.selection)
      expect(current.find).toEqual(baseline.find)
      expect(Math.abs(current.scrollTop - baseline.scrollTop)).toBeLessThanOrEqual(2)
      expect(await orcaPage.evaluate(() => 2 + 2)).toBe(4)
      expect((await readMainProcessCrashProbe(electronApp)).processGone).toBeNull()
      baseline = current
      if (batch === 0) {
        await orcaPage.keyboard.press('Escape')
        await expect(orcaPage.locator('.monaco-editor .find-widget')).toHaveAttribute(
          'aria-hidden',
          'true'
        )
        baseline = await readProbe(orcaPage)
        expect(baseline.find.open).toBe(false)
      }
    }

    console.log(
      `[live-log-stability] memory ${JSON.stringify({ suffixMemory, replacementMemory })}`
    )
    assertMemoryBudget(suffixMemory, replacementMemory)
    await testInfo.attach('synthetic-live-log-stable', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
  })
})

async function seedSyntheticSession(
  electronApp: ElectronApplication,
  cwd: string
): Promise<{ filePath: string; initialLength: number; title: string }> {
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const title = `Synthetic live log ${Date.now()}`
  const sessionId = `e2e-live-log-${Date.now()}`
  const sessionsDir = path.join(
    userData,
    'codex-runtime-home',
    'home',
    'sessions',
    '2026',
    '07',
    '12'
  )
  mkdirSync(sessionsDir, { recursive: true })
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`)
  const records = [
    JSON.stringify({
      timestamp: '2026-07-12T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd }
    }),
    JSON.stringify({
      timestamp: '2026-07-12T12:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: title }] }
    }),
    JSON.stringify({ type: 'synthetic', text: 'x'.repeat(INITIAL_PAYLOAD_BYTES / 2) }),
    JSON.stringify({ type: 'anchor', text: ANCHOR_TOKEN }),
    JSON.stringify({ type: 'synthetic', text: 'y'.repeat(INITIAL_PAYLOAD_BYTES / 2) })
  ]
  const content = `${records.join('\n')}\n`
  writeFileSync(filePath, content)
  return { filePath, initialLength: content.length, title }
}

async function openSessionHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setRightSidebarOpen(true)
    store.getState().setRightSidebarTab('vault')
  })
  await page.evaluate(async () => window.api.aiVault.listSessions({ force: true }))
  await page.getByRole('button', { name: 'Refresh Session History' }).click()
}

async function focusAnchorWithFind(page: Page): Promise<void> {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.locator('.monaco-editor').click()
  await page.keyboard.press(`${modifier}+f`)
  const findInput = page.locator('.monaco-editor .find-widget .input').first()
  await expect(findInput).toBeVisible()
  await findInput.fill(ANCHOR_TOKEN)
  await page.keyboard.press('Enter')
}

async function restoreAnchorState(
  page: Page,
  findOpen: boolean,
  targetScrollTop?: number
): Promise<Awaited<ReturnType<typeof readProbe>>> {
  await focusAnchorWithFind(page)
  await expect
    .poll(
      async () => {
        const snapshot = await readProbe(page)
        return (snapshot.selection as { startLineNumber?: number } | null)?.startLineNumber
      },
      { timeout: 60_000 }
    )
    .toBe(4)
  await expect
    .poll(async () => {
      const range = (await readProbe(page)).visibleRanges[0] as {
        startLineNumber?: number
        endLineNumber?: number
      }
      return (range.startLineNumber ?? 0) <= 4 && (range.endLineNumber ?? 0) >= 4
    })
    .toBe(true)
  if (!findOpen) {
    await page.keyboard.press('Escape')
    await expect(page.locator('.monaco-editor .find-widget')).toHaveAttribute('aria-hidden', 'true')
  }
  if (targetScrollTop !== undefined) {
    await page.evaluate((scrollTop) => {
      window.__monacoEditorE2E?.restoreScrollTop(scrollTop)
    }, targetScrollTop)
    await expect.poll(async () => (await readProbe(page)).scrollTop).toBe(targetScrollTop)
  }
  return readProbe(page)
}

async function readProbe(page: Page): Promise<{
  contentHeight: number
  filePath: string
  scrollTop: number
  selection: unknown
  valueLength: number
  valueTail: string
  visibleRanges: unknown[]
  find: { open: boolean; query: string; activeMatch: string }
}> {
  return page.evaluate(() => {
    const probe = window.__monacoEditorE2E
    if (!probe) {
      throw new Error('Monaco E2E probe unavailable')
    }
    return { filePath: probe.filePath, ...probe.snapshot() }
  })
}

async function armMainProcessCrashProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const probe: CrashProbe = { processGone: null }
    globalThis.__liveLogCrashProbe = probe
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.on('render-process-gone', (_event, details) => {
        probe.processGone = { reason: details.reason, exitCode: details.exitCode ?? -1 }
      })
    }
  })
}

async function readMainProcessCrashProbe(electronApp: ElectronApplication): Promise<CrashProbe> {
  return electronApp.evaluate(() => globalThis.__liveLogCrashProbe ?? { processGone: null })
}

async function forceGcAndSettle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gc = (window as unknown as { gc?: () => void }).gc
    if (!gc) {
      throw new Error('Forced GC unavailable; launch must include --js-flags=--expose-gc')
    }
    gc()
    gc()
  })
  await page.waitForTimeout(SETTLEMENT_MS)
}

async function readMemory(electronApp: ElectronApplication, page: Page): Promise<MemorySample> {
  const jsHeapMb = await page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
      ?.usedJSHeapSize
    if (!memory) {
      throw new Error('Precise renderer JS heap metrics unavailable')
    }
    return memory / 1024 / 1024
  })
  const metric = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId()
    const rendererMetric = app.getAppMetrics().find((candidate) => candidate.pid === rendererPid)
    if (!rendererMetric) {
      throw new Error(`Renderer app metric unavailable for pid ${rendererPid ?? 'unknown'}`)
    }
    return {
      pid: rendererMetric.pid,
      privateMb: rendererMetric.memory.privateBytes
        ? rendererMetric.memory.privateBytes / 1024
        : null,
      workingSetMb: rendererMetric.memory.workingSetSize / 1024
    }
  })
  const privateMb = metric.privateMb ?? readPrivateMemoryMb(metric.pid)
  return { jsHeapMb, privateMb, workingSetMb: metric.workingSetMb }
}

function readPrivateMemoryMb(pid: number): number {
  if (process.platform === 'linux') {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const privateKb = /RssAnon:\s+(\d+) kB/.exec(status)?.[1]
    if (!privateKb) {
      throw new Error(`Unable to parse renderer RssAnon for pid ${pid}`)
    }
    return Number(privateKb) / 1024
  }
  if (process.platform !== 'darwin') {
    throw new Error('app.getAppMetrics privateBytes unavailable on Windows')
  }
  // Electron omits MemoryInfo.privateBytes on macOS; footprint's
  // phys_footprint is the OS private-memory equivalent for the same renderer PID.
  const output = execFileSync('footprint', ['-p', String(pid), '-f', 'bytes', '--noCategories'], {
    encoding: 'utf8'
  })
  const bytes = /phys_footprint:\s+(\d+) B/.exec(output)?.[1]
  if (!bytes) {
    throw new Error(`Unable to parse renderer private footprint for pid ${pid}`)
  }
  return Number(bytes) / 1024 / 1024
}

async function measureLegacyControl(
  electronApp: ElectronApplication,
  page: Page,
  baseline: Awaited<ReturnType<typeof readProbe>>,
  batch: number
): Promise<{ before: MemorySample; after: MemorySample; settled: MemorySample }> {
  await forceGcAndSettle(page)
  const before = await readMemory(electronApp, page)
  await page.evaluate((index) => {
    window.__monacoEditorE2E?.runLegacySetValueAppend(
      `${JSON.stringify({ type: 'legacy_set_value_control', index, text: 'tail-only' })}\n`
    )
  }, batch)
  await page.waitForTimeout(APPEND_CADENCE_MS)
  const after = await readMemory(electronApp, page)
  const disrupted = await readProbe(page)
  console.log(
    `[live-log-stability] legacy-control ${JSON.stringify({ batch, baseline, disrupted })}`
  )
  expect(hasInstabilitySignal(baseline, disrupted)).toBe(true)
  await forceGcAndSettle(page)
  const settled = await readMemory(electronApp, page)
  await page.evaluate(() => window.__monacoEditorE2E?.restoreLegacySetValueControl())
  await expect.poll(() => readProbe(page)).toMatchObject({ valueLength: baseline.valueLength })
  expect((await readMainProcessCrashProbe(electronApp)).processGone).toBeNull()
  return { before, after, settled }
}

function hasInstabilitySignal(
  baseline: Awaited<ReturnType<typeof readProbe>>,
  current: Awaited<ReturnType<typeof readProbe>>
): boolean {
  return (
    JSON.stringify(current.selection) !== JSON.stringify(baseline.selection) ||
    JSON.stringify(current.find) !== JSON.stringify(baseline.find) ||
    JSON.stringify(current.visibleRanges) !== JSON.stringify(baseline.visibleRanges) ||
    Math.abs(current.scrollTop - baseline.scrollTop) > 2
  )
}

function assertMemoryBudget(
  suffix: { before: MemorySample; after: MemorySample; settled: MemorySample }[],
  replacement: { before: MemorySample; after: MemorySample; settled: MemorySample }[]
): void {
  expect(suffix).toHaveLength(replacement.length)
  expect(suffix.length).toBeGreaterThan(0)
  for (const sample of suffix) {
    for (const field of ['jsHeapMb', 'workingSetMb', 'privateMb'] as const) {
      const retainedAllowance = Math.max(20, sample.before[field] * 0.1)
      expect(sample.settled[field] - sample.before[field]).toBeLessThanOrEqual(retainedAllowance)
    }
  }
  for (const [index, sample] of suffix.entries()) {
    const pairedReplacement = replacement[index]
    expect(pairedReplacement).toBeDefined()
    for (const field of ['jsHeapMb', 'workingSetMb', 'privateMb'] as const) {
      const suffixPeak = sample.after[field] - sample.before[field]
      const replacementPeak = pairedReplacement.after[field] - pairedReplacement.before[field]
      // Why: the legacy control provably allocates more (getValue plus a whole
      // TextEncoder/Decoder round-trip and full model rebuild), so an append peak
      // above it is GC-timing noise, not a regression; allow a noise margin.
      expect(suffixPeak).toBeLessThanOrEqual(replacementPeak + PEAK_MEMORY_NOISE_ALLOWANCE_MB)
    }
  }
}

async function readProbeOrNull(page: Page): Promise<Awaited<ReturnType<typeof readProbe>> | null> {
  return page.evaluate(() => {
    const probe = window.__monacoEditorE2E
    return probe ? { filePath: probe.filePath, ...probe.snapshot() } : null
  })
}
