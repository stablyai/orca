import type { CDPSession, Page } from '@stablyai/playwright-test'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  focusActiveTerminalInput,
  waitForMarkerLatency,
  waitForTerminalOutputForPtyId
} from './artificial-opencode-pane-interactions'
import { sendToTerminal } from './helpers/terminal'

export type TerminalLatencyMeasurement = {
  maxTimerDriftMs: number
  controllerMaxTimerDriftMs: number
  rendererMaxLongTaskMs: number
  rendererLongTaskSupported: boolean
  rendererKeydownCount: number
  rendererTaskDurationMs: number | null
  rendererScriptDurationMs: number | null
  hostCpuBusyPercent: number | null
  hostCpuPressureWaitMs: number | null
  elapsedMs: number
}

export type TypingMeasurement = TerminalLatencyMeasurement & {
  latencies: number[]
  dispatchLatencies: number[]
  echoLatencies: number[]
  medianLatencyMs: number
  worstLatencyMs: number
  frameCount: number
}

type HostCpuSnapshot = {
  idleTicks: number
  pressureWaitMicros: number | null
  totalTicks: number
}

type RendererDurationSnapshot = {
  scriptDurationMs: number
  taskDurationMs: number
}

const KEY_LATENCY_SAMPLES = 'abcdefghijklmnop'
const MAX_KEY_ECHO_LATENCY_MS = 3_000
const TIMER_SAMPLE_MS = 16

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function readLinuxCpuPressureWaitMicros(): number | null {
  try {
    const match = readFileSync('/proc/pressure/cpu', 'utf8').match(/^some\s+.*\btotal=(\d+)$/m)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

function readHostCpuSnapshot(): HostCpuSnapshot | null {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    const cpuFields = readFileSync('/proc/stat', 'utf8')
      .split('\n')[0]
      ?.trim()
      .split(/\s+/)
      .slice(1)
      .map(Number)
    if (!cpuFields || cpuFields.length < 4 || cpuFields.some((value) => !Number.isFinite(value))) {
      return null
    }
    return {
      idleTicks: cpuFields[3] + (cpuFields[4] ?? 0),
      pressureWaitMicros: readLinuxCpuPressureWaitMicros(),
      totalTicks: cpuFields.reduce((total, value) => total + value, 0)
    }
  } catch {
    return null
  }
}

function hostCpuDelta(
  start: HostCpuSnapshot | null,
  end: HostCpuSnapshot | null
): {
  busyPercent: number | null
  pressureWaitMs: number | null
} {
  if (!start || !end) {
    return { busyPercent: null, pressureWaitMs: null }
  }
  const totalTicks = end.totalTicks - start.totalTicks
  const idleTicks = end.idleTicks - start.idleTicks
  const pressureWaitMicros =
    start.pressureWaitMicros == null || end.pressureWaitMicros == null
      ? null
      : end.pressureWaitMicros - start.pressureWaitMicros
  return {
    busyPercent: totalTicks > 0 ? ((totalTicks - idleTicks) / totalTicks) * 100 : null,
    pressureWaitMs: pressureWaitMicros == null ? null : pressureWaitMicros / 1_000
  }
}

function startControllerTimerDrift(): () => number {
  let maxTimerDriftMs = 0
  let lastTick = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - TIMER_SAMPLE_MS)
    lastTick = now
  }, TIMER_SAMPLE_MS)
  return () => {
    clearInterval(timer)
    return maxTimerDriftMs
  }
}

async function readRendererDurationSnapshot(
  session: CDPSession
): Promise<RendererDurationSnapshot> {
  const { metrics } = await session.send('Performance.getMetrics')
  const metric = (name: string): number =>
    (metrics.find((candidate) => candidate.name === name)?.value ?? 0) * 1_000
  return {
    scriptDurationMs: metric('ScriptDuration'),
    taskDurationMs: metric('TaskDuration')
  }
}

async function startRendererDurationMeasurement(page: Page): Promise<{
  stop: () => Promise<{
    scriptDurationMs: number | null
    taskDurationMs: number | null
  }>
}> {
  let session: CDPSession | null = null
  let start: RendererDurationSnapshot | null = null
  try {
    session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    start = await readRendererDurationSnapshot(session)
  } catch {
    await session?.detach().catch(() => {})
    session = null
  }
  return {
    stop: async () => {
      if (!session || !start) {
        return { scriptDurationMs: null, taskDurationMs: null }
      }
      try {
        const end = await readRendererDurationSnapshot(session)
        return {
          scriptDurationMs: end.scriptDurationMs - start.scriptDurationMs,
          taskDurationMs: end.taskDurationMs - start.taskDurationMs
        }
      } catch {
        return { scriptDurationMs: null, taskDurationMs: null }
      } finally {
        await session.detach().catch(() => {})
      }
    }
  }
}

export async function measureTerminalOperationLatency(
  page: Page,
  operation: () => Promise<void>
): Promise<TerminalLatencyMeasurement> {
  const rendererDuration = await startRendererDurationMeasurement(page)
  const rendererWatcher = await page.evaluateHandle((sampleMs) => {
    let maxTimerDriftMs = 0
    let maxLongTaskMs = 0
    let keydownCount = 0
    let lastTick = window.performance.now()
    const timer = window.setInterval(() => {
      const now = window.performance.now()
      maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
      lastTick = now
    }, sampleMs)
    const onKeydown = (): void => {
      keydownCount += 1
    }
    window.addEventListener('keydown', onKeydown, true)
    const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask')
    const observer = longTaskSupported
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration)
          }
        })
      : null
    observer?.observe({ type: 'longtask' })
    return {
      stop: () => {
        window.clearInterval(timer)
        window.removeEventListener('keydown', onKeydown, true)
        for (const entry of observer?.takeRecords() ?? []) {
          maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration)
        }
        observer?.disconnect()
        return { keydownCount, longTaskSupported, maxLongTaskMs, maxTimerDriftMs }
      }
    }
  }, TIMER_SAMPLE_MS)
  const stopControllerTimer = startControllerTimerDrift()
  const hostCpuStart = readHostCpuSnapshot()
  const measurementStart = performance.now()
  let controllerMaxTimerDriftMs = 0
  let elapsedMs = 0
  let hostCpuEnd: HostCpuSnapshot | null = null
  let rendererDurationDelta = {
    scriptDurationMs: null as number | null,
    taskDurationMs: null as number | null
  }
  let rendererTiming = {
    keydownCount: 0,
    longTaskSupported: false,
    maxLongTaskMs: 0,
    maxTimerDriftMs: 0
  }
  try {
    await operation()
  } finally {
    try {
      rendererTiming = await rendererWatcher.evaluate((watcher) => watcher.stop())
    } finally {
      controllerMaxTimerDriftMs = stopControllerTimer()
      hostCpuEnd = readHostCpuSnapshot()
      elapsedMs = performance.now() - measurementStart
      rendererDurationDelta = await rendererDuration.stop()
      await rendererWatcher.dispose()
    }
  }
  const hostCpu = hostCpuDelta(hostCpuStart, hostCpuEnd)
  return {
    maxTimerDriftMs: rendererTiming.maxTimerDriftMs,
    controllerMaxTimerDriftMs,
    rendererMaxLongTaskMs: rendererTiming.maxLongTaskMs,
    rendererLongTaskSupported: rendererTiming.longTaskSupported,
    rendererKeydownCount: rendererTiming.keydownCount,
    rendererTaskDurationMs: rendererDurationDelta.taskDurationMs,
    rendererScriptDurationMs: rendererDurationDelta.scriptDurationMs,
    hostCpuBusyPercent: hostCpu.busyPercent,
    hostCpuPressureWaitMs: hostCpu.pressureWaitMs,
    elapsedMs
  }
}

export async function measureTerminalTypingDuringLoad(
  page: Page,
  scriptPath: string,
  ptyId: string,
  runId: string,
  frameCount: number
): Promise<TypingMeasurement> {
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
  await waitForTerminalOutputForPtyId(page, ptyId, `OPENCODE_TYPING_READY_${runId}`, 10_000)
  await focusActiveTerminalInput(page)

  const latencies: number[] = []
  const dispatchLatencies: number[] = []
  const echoLatencies: number[] = []
  const timing = await measureTerminalOperationLatency(page, async () => {
    for (const [index, char] of KEY_LATENCY_SAMPLES.split('').entries()) {
      const marker = `OPENCODE_TYPING_KEY_${runId}_${index + 1}`
      const start = performance.now()
      await page.keyboard.type(char)
      const dispatched = performance.now()
      await waitForMarkerLatency(page, marker, MAX_KEY_ECHO_LATENCY_MS)
      const completed = performance.now()
      dispatchLatencies.push(dispatched - start)
      echoLatencies.push(completed - dispatched)
      latencies.push(completed - start)
    }
  })
  return {
    ...timing,
    latencies,
    dispatchLatencies,
    echoLatencies,
    medianLatencyMs: median(latencies),
    worstLatencyMs: Math.max(...latencies),
    frameCount
  }
}
