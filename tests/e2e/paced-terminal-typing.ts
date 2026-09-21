import type { Page } from '@stablyai/playwright-test'
import { readFileSync } from 'node:fs'
import { focusActiveTerminalInput } from './helpers/terminal'
import { typingKeyMarkerPrefix } from './sustained-agent-typing-load-scripts'

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz'
const TIMER_SAMPLE_MS = 16
const MARKER_SCAN_TRAILING_ROWS = 160
const ECHO_STRAGGLER_TIMEOUT_MS = 30_000

export type LatencyStats = {
  count: number
  p50: number
  p90: number
  p99: number
  max: number
}

type KeySample = {
  seq: number
  sentAt: number
  ptyArrivedAt: number | null
  echoSeenAt: number | null
}

export type PacedTypingMeasurement = {
  keyCount: number
  missingPtyArrivalCount: number
  missingEchoCount: number
  totalMs: LatencyStats | null
  inputHalfMs: LatencyStats | null
  echoHalfMs: LatencyStats | null
  maxTimerDriftMs: number
  samples: KeySample[]
}

function latencyStats(samples: number[]): LatencyStats | null {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    count: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0
  }
}

async function scanRecentKeyMarkerSeqs(
  page: Page,
  markerPrefix: string
): Promise<{ seqs: number[]; atMs: number }> {
  return page.evaluate(
    ({ markerPrefix, trailingRows }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const seqs: number[] = []
      if (!pane) {
        return { seqs, atMs: Date.now() }
      }
      // Why trailing rows, not serialize: full-buffer serialization on every
      // poll runs on the renderer main thread and would perturb the very
      // latency being measured (same rationale as the history-size spec).
      const re = new RegExp(`${markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`, 'g')
      const buffer = pane.terminal.buffer.active
      const start = Math.max(0, buffer.length - trailingRows)
      for (let row = start; row < buffer.length; row += 1) {
        const line = buffer.getLine(row)?.translateToString(true) ?? ''
        let match: RegExpExecArray | null
        while ((match = re.exec(line)) !== null) {
          seqs.push(Number(match[1]))
        }
      }
      return { seqs, atMs: Date.now() }
    },
    { markerPrefix, trailingRows: MARKER_SCAN_TRAILING_ROWS }
  )
}

function readKeyArrivalSidecar(sidecarPath: string): Map<number, number> {
  const arrivals = new Map<number, number>()
  let raw = ''
  try {
    raw = readFileSync(sidecarPath, 'utf8')
  } catch {
    return arrivals
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const entry = JSON.parse(line) as { seq: number; atMs: number }
      arrivals.set(entry.seq, entry.atMs)
    } catch {
      /* torn tail write; final retry pass re-reads */
    }
  }
  return arrivals
}

export async function measurePacedTyping(
  page: Page,
  runId: string,
  sidecarPath: string,
  options: { keyCount: number; keyCadenceMs: number }
): Promise<PacedTypingMeasurement> {
  const markerPrefix = typingKeyMarkerPrefix(runId)
  await focusActiveTerminalInput(page)

  const timerDrift = await page.evaluateHandle((sampleMs) => {
    let maxTimerDriftMs = 0
    let lastTick = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
      lastTick = now
    }, sampleMs)
    return {
      stop: () => {
        window.clearInterval(timer)
        return maxTimerDriftMs
      }
    }
  }, TIMER_SAMPLE_MS)

  // Concurrent echo watcher: records the first time each key's marker is
  // visible in the buffer, while typing continues at its own cadence.
  const echoSeenAt = new Map<number, number>()
  let watching = true
  const echoWatcher = (async () => {
    while (watching) {
      const { seqs, atMs } = await scanRecentKeyMarkerSeqs(page, markerPrefix)
      for (const seq of seqs) {
        if (!echoSeenAt.has(seq)) {
          echoSeenAt.set(seq, atMs)
        }
      }
      await page.waitForTimeout(10)
    }
  })()

  const sentAtBySeq = new Map<number, number>()
  try {
    for (let index = 0; index < options.keyCount; index++) {
      const seq = index + 1
      const tickStart = Date.now()
      sentAtBySeq.set(seq, tickStart)
      await page.keyboard.type(KEY_CHARS[index % KEY_CHARS.length])
      const elapsed = Date.now() - tickStart
      if (elapsed < options.keyCadenceMs) {
        await page.waitForTimeout(options.keyCadenceMs - elapsed)
      }
    }
    // Wait out stragglers so a slow echo is measured, not dropped.
    const stragglerDeadline = Date.now() + ECHO_STRAGGLER_TIMEOUT_MS
    while (echoSeenAt.size < options.keyCount && Date.now() < stragglerDeadline) {
      await page.waitForTimeout(25)
    }
  } finally {
    watching = false
    await echoWatcher
  }
  const maxTimerDriftMs = await timerDrift.evaluate((watcher) => watcher.stop())
  await timerDrift.dispose()

  // The probe appends arrivals asynchronously; re-read until complete or 5s.
  let arrivals = readKeyArrivalSidecar(sidecarPath)
  const sidecarDeadline = Date.now() + 5_000
  while (arrivals.size < options.keyCount && Date.now() < sidecarDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    arrivals = readKeyArrivalSidecar(sidecarPath)
  }

  const samples: KeySample[] = []
  const totalMs: number[] = []
  const inputHalfMs: number[] = []
  const echoHalfMs: number[] = []
  for (let seq = 1; seq <= options.keyCount; seq++) {
    const sentAt = sentAtBySeq.get(seq) ?? 0
    const ptyArrivedAt = arrivals.get(seq) ?? null
    const seenAt = echoSeenAt.get(seq) ?? null
    samples.push({ seq, sentAt, ptyArrivedAt, echoSeenAt: seenAt })
    if (ptyArrivedAt !== null) {
      inputHalfMs.push(ptyArrivedAt - sentAt)
    }
    if (seenAt !== null) {
      totalMs.push(seenAt - sentAt)
      if (ptyArrivedAt !== null) {
        echoHalfMs.push(seenAt - ptyArrivedAt)
      }
    }
  }

  return {
    keyCount: options.keyCount,
    missingPtyArrivalCount: options.keyCount - arrivals.size,
    missingEchoCount: options.keyCount - echoSeenAt.size,
    totalMs: latencyStats(totalMs),
    inputHalfMs: latencyStats(inputHalfMs),
    echoHalfMs: latencyStats(echoHalfMs),
    maxTimerDriftMs,
    samples
  }
}
