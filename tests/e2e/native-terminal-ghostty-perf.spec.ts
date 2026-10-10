import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeTerminalDebug,
  xtermScreenTransform
} from './helpers/native-terminal-debug'
import {
  addTerminalPane,
  cpuMsBetween,
  openTerminalTab,
  usageSnapshot,
  type CpuMsByKind
} from './helpers/native-terminal-process-usage'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { nodeTerminalCommand } from './terminal-node-command'
import {
  typingKeyMarkerPrefix,
  typingProbeReadyMarker,
  writeTypingEchoProbeScript
} from './sustained-agent-typing-load-scripts'
import { summarizeBenchmarkSamples } from '../../config/scripts/benchmark-sample-summary.mjs'

// Same workloads with experimentalNativeTerminal off (xterm.js WebGL), on (Ghostty/Metal fed by
// main), and on with main's feed off (fed by the renderer mirror): an output flood,
// keystroke-to-echo latency, and idle CPU with four panes. Opt-in, not a gate.
//   ORCA_NATIVE_TERMINAL_BENCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/native-terminal-ghostty-perf.spec.ts

type Mode = 'xterm' | 'native' | 'native-mirror'

const enabled = process.env.ORCA_NATIVE_TERMINAL_BENCH === '1'
const rounds = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_ROUNDS ?? 5)
const floodLines = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_FLOOD_LINES ?? 300_000)
const keyCount = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_KEYS ?? 30)
const idleMs = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_IDLE_MS ?? 10_000)
const IDLE_PANES = 4
const SETTLE_MS = 3_000
const KEY_GAP_MS = 40
const FLOOD_TIMEOUT_MS = 120_000
const KEY_TIMEOUT_MS = 2_000
// Main-side screen polling for the native path; coarse during floods so it barely costs CPU.
const FLOOD_POLL_MS = 5
const KEY_POLL_MS = 1
const MIRROR_WRITES_KEY = '__orcaE2eNativeMirrorWrites'

test.use({
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  trace: 'off',
  screenshot: 'off'
})
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')
test.skip(!enabled, 'Opt-in benchmark: set ORCA_NATIVE_TERMINAL_BENCH=1')

type XtermWatch = {
  keyAt: number | null
  parsedAt: number | null
  paintedAt: number | null
  renders: number
  frames: number
}

type FloodSample = {
  wallMs: number
  cpuMs: CpuMsByKind
  xtermRenders: number
  frames: number
  // Renderer-to-main 'nativeTerminal:write' messages; PTY chunks main's feed took, and the
  // batched addon writes it made of them.
  mirrorWrites: number
  mainFeedChunks: number
  mainFeedWrites: number
}
type KeySample = { keyToScreenMs: number; keyToParsedMs: number | null; keyToPtyMs: number | null }
type ModeSamples = {
  flood: FloodSample[]
  keys: KeySample[]
  idleCpuMsPerS: CpuMsByKind[]
  webgl: boolean[]
  keyMirrorWrites: number[]
}

function now(): number {
  return performance.timeOrigin + performance.now()
}

// Counts renderer-to-main mirror writes; main's own feed sends none.
async function installMirrorWriteCounter(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, key) => {
    const counter = { writes: 0 }
    Reflect.set(globalThis, key, counter)
    ipcMain.on('nativeTerminal:write', () => {
      counter.writes += 1
    })
  }, MIRROR_WRITES_KEY)
}

function mirrorWrites(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    (_electron, key) => Number(Reflect.get(Object(Reflect.get(globalThis, key)), 'writes')),
    MIRROR_WRITES_KEY
  )
}

async function mainFeedStats(
  app: ElectronApplication
): Promise<{ chunks: number; writes: number }> {
  const stats: unknown = await nativeTerminalDebug(app, 'mainFeed')
  const read = (field: string): number =>
    typeof stats === 'object' && stats !== null ? Number(Reflect.get(stats, field)) : 0
  return { chunks: read('chunks'), writes: read('writes') }
}

function emptySamples(): ModeSamples {
  return { flood: [], keys: [], idleCpuMsPerS: [], webgl: [], keyMirrorWrites: [] }
}

function scaleCpu(cpu: CpuMsByKind, factor: number): CpuMsByKind {
  return {
    main: cpu.main * factor,
    renderer: cpu.renderer * factor,
    gpu: cpu.gpu * factor,
    total: cpu.total * factor
  }
}

// Arms a page-side watch on the pane's xterm for a line ending in `marker`: when xterm parsed
// it, when it next painted, and how many renders and animation frames ran meanwhile.
async function armXtermWatch(
  page: Page,
  ptyId: string,
  marker: string,
  waitForPaint: boolean,
  timeoutMs: number
): Promise<string> {
  const key = `__orcaNativePerfWatch_${randomUUID()}`
  await page.evaluate(
    ({ id, watchKey, line, paint, timeout }) => {
      const pane = [...(window.__paneManagers?.values() ?? [])]
        .flatMap((manager) => manager.getPanes())
        .find((candidate) => candidate.container.dataset.ptyId === id)
      if (!pane) {
        throw new Error(`no pane for PTY ${id}`)
      }
      const terminal = pane.terminal
      const clock = (): number => performance.timeOrigin + performance.now()
      const result: {
        keyAt: number | null
        parsedAt: number | null
        paintedAt: number | null
        renders: number
        frames: number
      } = { keyAt: null, parsedAt: null, paintedAt: null, renders: 0, frames: 0 }
      const lineOnScreen = (): boolean => {
        const buffer = terminal.buffer.active
        const end = buffer.baseY + buffer.cursorY
        for (let y = end; y >= Math.max(0, end - 3); y -= 1) {
          if (buffer.getLine(y)?.translateToString(true).endsWith(line)) {
            return true
          }
        }
        return false
      }
      const done = new Promise((resolve) => {
        const cleanups: (() => void)[] = []
        const finish = (): void => {
          for (const cleanup of cleanups) {
            cleanup()
          }
          resolve(result)
        }
        let frame = requestAnimationFrame(function tick() {
          result.frames += 1
          frame = requestAnimationFrame(tick)
        })
        cleanups.push(() => cancelAnimationFrame(frame))
        const onKey = (event: KeyboardEvent): void => {
          result.keyAt ??= performance.timeOrigin + event.timeStamp
        }
        window.addEventListener('keydown', onKey, true)
        cleanups.push(() => window.removeEventListener('keydown', onKey, true))
        const parsed = terminal.onWriteParsed(() => {
          if (result.parsedAt === null && lineOnScreen()) {
            result.parsedAt = clock()
            if (!paint) {
              finish()
            }
          }
        })
        cleanups.push(() => parsed.dispose())
        const rendered = terminal.onRender(() => {
          result.renders += 1
          if (paint && result.parsedAt !== null && result.paintedAt === null) {
            result.paintedAt = clock()
            finish()
          }
        })
        cleanups.push(() => rendered.dispose())
        const timer = setTimeout(finish, timeout)
        cleanups.push(() => clearTimeout(timer))
      })
      Reflect.set(window, watchKey, done)
    },
    { id: ptyId, watchKey: key, line: marker, paint: waitForPaint, timeout: timeoutMs }
  )
  return key
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function readXtermWatch(page: Page, key: string): Promise<XtermWatch> {
  const value: unknown = await page.evaluate((watchKey) => Reflect.get(window, watchKey), key)
  if (typeof value !== 'object' || value === null) {
    throw new Error('xterm watch returned nothing')
  }
  return {
    keyAt: numberOrNull(Reflect.get(value, 'keyAt')),
    parsedAt: numberOrNull(Reflect.get(value, 'parsedAt')),
    paintedAt: numberOrNull(Reflect.get(value, 'paintedAt')),
    renders: Number(Reflect.get(value, 'renders')),
    frames: Number(Reflect.get(value, 'frames'))
  }
}

// Polls the native surface's screen in main until a line ends with `marker`.
function watchNativeScreen(
  app: ElectronApplication,
  surfaceId: number,
  marker: string,
  pollMs: number,
  timeoutMs: number
): Promise<number | null> {
  return app.evaluate(
    async (_electron, { id, line, poll, timeout }) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const screenText: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'screenText') : null
      if (typeof screenText !== 'function') {
        throw new Error('native terminal debug hooks are not installed')
      }
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        const text: unknown = Reflect.apply(screenText, debug, [id])
        if (
          typeof text === 'string' &&
          text.split('\n').some((row) => row.trimEnd().endsWith(line))
        ) {
          return performance.timeOrigin + performance.now()
        }
        await new Promise((resolve) => setTimeout(resolve, poll))
      }
      return null
    },
    { id: surfaceId, line: marker, poll: pollMs, timeout: timeoutMs }
  )
}

// One keystroke into the native view (the same keyDown path AppKit drives) timed until its
// echo is on the native screen, measured inside main so no test-runner round trip is counted.
function nativeKeystroke(
  app: ElectronApplication,
  surfaceId: number,
  character: string,
  marker: string
): Promise<{ keyAt: number; shownAt: number | null }> {
  return app.evaluate(
    async (_electron, { id, char, line, poll, timeout }) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const key: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'key') : null
      const screenText: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'screenText') : null
      if (typeof key !== 'function' || typeof screenText !== 'function') {
        throw new Error('native terminal debug hooks are not installed')
      }
      const keyAt = performance.timeOrigin + performance.now()
      Reflect.apply(key, debug, [id, char, 0, 0])
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        const text: unknown = Reflect.apply(screenText, debug, [id])
        if (
          typeof text === 'string' &&
          text.split('\n').some((row) => row.trimEnd().endsWith(line))
        ) {
          return { keyAt, shownAt: performance.timeOrigin + performance.now() }
        }
        await new Promise((resolve) => setTimeout(resolve, poll))
      }
      return { keyAt, shownAt: null }
    },
    { id: surfaceId, char: character, line: marker, poll: KEY_POLL_MS, timeout: KEY_TIMEOUT_MS }
  )
}

function closeTab(page: Page, tabId: string): Promise<void> {
  return page.evaluate((id) => window.__store?.getState().closeTab(id), tabId)
}

function activePaneUsesWebgl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane()
    return pane ? manager?.hasWebglRenderer(pane.id) === true : false
  })
}

// A fresh pane in this mode; for native, the surface that shows it.
async function openBenchmarkPane(
  page: Page,
  app: ElectronApplication,
  mode: Mode
): Promise<{ tabId: string; ptyId: string; surfaceId: number | null }> {
  await nativeTerminalDebug(app, 'mainFeed', [mode !== 'native-mirror'])
  await enableNativeTerminal(page, mode !== 'xterm')
  const tabId = await openTerminalTab(page)
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  await waitForPtyShellEcho(page, ptyId, 30_000)
  const surfaceId = await findNativeSurfaceForPane(page, ptyId, mode === 'xterm' ? 1_000 : 15_000)
  // The xterm baseline must not have a native view; the native run must have one, on screen.
  expect(surfaceId === null).toBe(mode === 'xterm')
  if (surfaceId !== null) {
    await expect.poll(async () => isNativeSurfaceHidden(app, surfaceId)).toBe(false)
    // Steady state: xterm has stopped painting under the native view.
    await expect.poll(async () => xtermScreenTransform(page, ptyId)).not.toBe('')
  }
  return { tabId, ptyId, surfaceId }
}

async function measureFlood(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number | null
): Promise<FloodSample> {
  const id = randomUUID()
  const marker = `FLOOD-${id}`
  const watch = await armXtermWatch(page, ptyId, marker, surfaceId === null, FLOOD_TIMEOUT_MS)
  const writesBefore = await mirrorWrites(app)
  const feedBefore = await mainFeedStats(app)
  const before = await usageSnapshot(app)
  const startedAt = now()
  const native =
    surfaceId === null
      ? null
      : watchNativeScreen(app, surfaceId, marker, FLOOD_POLL_MS, FLOOD_TIMEOUT_MS)
  await sendToTerminal(page, ptyId, `seq 1 ${floodLines}; printf 'FLOOD-%s\\n' ${id}\r`)
  const xterm = await readXtermWatch(page, watch)
  const shownAt = native ? await native : xterm.paintedAt
  const after = await usageSnapshot(app)
  if (shownAt === null) {
    throw new Error(`flood did not reach the ${surfaceId === null ? 'xterm' : 'native'} screen`)
  }
  const feedAfter = await mainFeedStats(app)
  return {
    wallMs: shownAt - startedAt,
    cpuMs: cpuMsBetween(before, after),
    xtermRenders: xterm.renders,
    frames: xterm.frames,
    mirrorWrites: (await mirrorWrites(app)) - writesBefore,
    mainFeedChunks: feedAfter.chunks - feedBefore.chunks,
    mainFeedWrites: feedAfter.writes - feedBefore.writes
  }
}

async function measureKeystrokes(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number | null,
  testInfo: TestInfo
): Promise<{ keys: KeySample[]; mirrorWrites: number }> {
  const runId = randomUUID().slice(0, 8)
  const scriptPath = testInfo.outputPath(`echo-${runId}.mjs`)
  const arrivalsPath = testInfo.outputPath(`arrivals-${runId}.jsonl`)
  writeTypingEchoProbeScript(scriptPath, runId, arrivalsPath)
  await sendToTerminal(page, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
  await waitForTerminalOutput(page, typingProbeReadyMarker(runId), 15_000)
  if (surfaceId === null) {
    await focusActiveTerminalInput(page)
  }
  const timings: { keyAt: number; parsedAt: number | null; shownAt: number }[] = []
  const writesBefore = await mirrorWrites(app)
  for (let seq = 1; seq <= keyCount; seq += 1) {
    const character = String.fromCharCode(97 + ((seq - 1) % 26))
    const marker = `${typingKeyMarkerPrefix(runId)}${seq}`
    if (surfaceId === null) {
      const watch = await armXtermWatch(page, ptyId, marker, true, KEY_TIMEOUT_MS)
      await page.keyboard.type(character)
      const result = await readXtermWatch(page, watch)
      if (result.keyAt === null || result.paintedAt === null) {
        throw new Error(`xterm key ${seq} never echoed`)
      }
      timings.push({ keyAt: result.keyAt, parsedAt: result.parsedAt, shownAt: result.paintedAt })
    } else {
      const result = await nativeKeystroke(app, surfaceId, character, marker)
      if (result.shownAt === null) {
        throw new Error(`native key ${seq} never echoed`)
      }
      timings.push({ keyAt: result.keyAt, parsedAt: null, shownAt: result.shownAt })
    }
    await page.waitForTimeout(KEY_GAP_MS)
  }
  const keyWrites = (await mirrorWrites(app)) - writesBefore
  await sendToTerminal(page, ptyId, '\x03')
  const arrivals = new Map<number, number>()
  if (existsSync(arrivalsPath)) {
    for (const row of readFileSync(arrivalsPath, 'utf8').split('\n')) {
      if (row.trim().length === 0) {
        continue
      }
      const parsed: unknown = JSON.parse(row)
      const seq = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'seq') : null
      const atMs =
        typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'atMs') : null
      if (typeof seq === 'number' && typeof atMs === 'number') {
        arrivals.set(seq, atMs)
      }
    }
  }
  const keys = timings.map((timing, index) => {
    const arrivedAt = arrivals.get(index + 1)
    return {
      keyToScreenMs: timing.shownAt - timing.keyAt,
      keyToParsedMs: timing.parsedAt === null ? null : timing.parsedAt - timing.keyAt,
      keyToPtyMs: arrivedAt === undefined ? null : arrivedAt - timing.keyAt
    }
  })
  return { keys, mirrorWrites: keyWrites }
}

async function measureIdle(page: Page, app: ElectronApplication, mode: Mode): Promise<CpuMsByKind> {
  for (let pane = 1; pane < IDLE_PANES; pane += 1) {
    await addTerminalPane(page, app, mode === 'xterm' ? 'xterm' : 'native', pane)
  }
  await page.waitForTimeout(SETTLE_MS)
  const before = await usageSnapshot(app)
  await page.waitForTimeout(idleMs)
  const after = await usageSnapshot(app)
  return scaleCpu(cpuMsBetween(before, after), 1000 / (after.at - before.at))
}

function summarize(values: number[]): ReturnType<typeof summarizeBenchmarkSamples> | null {
  return values.length > 0 ? summarizeBenchmarkSamples(values) : null
}

function summarizeCpu(
  samples: CpuMsByKind[]
): Record<keyof CpuMsByKind, ReturnType<typeof summarize>> {
  return {
    main: summarize(samples.map((sample) => sample.main)),
    renderer: summarize(samples.map((sample) => sample.renderer)),
    gpu: summarize(samples.map((sample) => sample.gpu)),
    total: summarize(samples.map((sample) => sample.total))
  }
}

function summarizeMode(samples: ModeSamples): Record<string, unknown> {
  return {
    webglPanes: samples.webgl,
    floodWallMs: summarize(samples.flood.map((sample) => sample.wallMs)),
    floodCpuMs: summarizeCpu(samples.flood.map((sample) => sample.cpuMs)),
    floodXtermRenders: samples.flood.map((sample) => sample.xtermRenders),
    floodAnimationFrames: samples.flood.map((sample) => sample.frames),
    floodMirrorWrites: samples.flood.map((sample) => sample.mirrorWrites),
    floodMainFeedChunks: samples.flood.map((sample) => sample.mainFeedChunks),
    floodMainFeedWrites: samples.flood.map((sample) => sample.mainFeedWrites),
    keyMirrorWrites: samples.keyMirrorWrites,
    keyToScreenMs: summarize(samples.keys.map((sample) => sample.keyToScreenMs)),
    keyToXtermParsedMs: summarize(
      samples.keys.flatMap((sample) =>
        sample.keyToParsedMs === null ? [] : [sample.keyToParsedMs]
      )
    ),
    keyToPtyMs: summarize(
      samples.keys.flatMap((sample) => (sample.keyToPtyMs === null ? [] : [sample.keyToPtyMs]))
    ),
    idleCpuMsPerS: summarizeCpu(samples.idleCpuMsPerS)
  }
}

test('native terminal vs xterm.js: output flood, keystroke echo, idle CPU', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(60 * 60_000)
  for (const [name, value, minimum] of [
    ['rounds', rounds, 1],
    ['flood lines', floodLines, 1],
    ['keys', keyCount, 1],
    ['idle ms', idleMs, 1000]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`Invalid native terminal benchmark ${name}: ${value}`)
    }
  }
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  // Why: the hidden test window would otherwise throttle rAF, and xterm would never paint.
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
  })
  // Why: a one-time sidebar hint popover overlaps the terminal and would hide native views.
  await expect
    .poll(async () => orcaPage.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  await installMirrorWriteCounter(electronApp)

  const modes: Mode[] = ['xterm', 'native', 'native-mirror']
  const samples: Record<Mode, ModeSamples> = {
    xterm: emptySamples(),
    native: emptySamples(),
    'native-mirror': emptySamples()
  }
  for (let round = 0; round < rounds; round += 1) {
    // Rotate the order so warm-up and thermal drift do not favor one mode.
    for (const mode of modes.map((_, index) => modes[(index + round) % modes.length])) {
      const { tabId, ptyId, surfaceId } = await openBenchmarkPane(orcaPage, electronApp, mode)
      samples[mode].webgl.push(await activePaneUsesWebgl(orcaPage))
      samples[mode].flood.push(await measureFlood(orcaPage, electronApp, ptyId, surfaceId))
      const typed = await measureKeystrokes(orcaPage, electronApp, ptyId, surfaceId, testInfo)
      samples[mode].keys.push(...typed.keys)
      samples[mode].keyMirrorWrites.push(typed.mirrorWrites)
      samples[mode].idleCpuMsPerS.push(await measureIdle(orcaPage, electronApp, mode))
      await closeTab(orcaPage, tabId)
      await orcaPage.waitForTimeout(1_000)
    }
  }
  await nativeTerminalDebug(electronApp, 'mainFeed', [true])

  const summaries = {
    xterm: summarizeMode(samples.xterm),
    native: summarizeMode(samples.native),
    'native-mirror': summarizeMode(samples['native-mirror'])
  }
  const report = {
    config: { rounds, floodLines, keyCount, idleMs, idlePanes: IDLE_PANES },
    ...summaries,
    samples
  }
  const output =
    process.env.ORCA_NATIVE_TERMINAL_BENCH_OUTPUT ??
    testInfo.outputPath('native-terminal-perf.json')
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach('native-terminal-perf', { path: output, contentType: 'application/json' })
  console.log(JSON.stringify(summaries, null, 2))
})
