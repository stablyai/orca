import type { Page } from '@stablyai/playwright-test'
import { existsSync, readFileSync } from 'node:fs'
import { focusActiveTerminalInput } from './helpers/terminal'
import {
  buildPacedTypingMeasurement,
  PACED_TYPING_CHARACTERS,
  parseKeyArrivalSidecar,
  type KeyArrivalRecord,
  type PacedTypingMeasurement
} from './paced-terminal-typing-measurement'
import { typingKeyMarkerPrefix } from './sustained-agent-typing-load-scripts'

const TIMER_SAMPLE_MS = 16
const MARKER_SCAN_TRAILING_ROWS = 160
const ECHO_STRAGGLER_TIMEOUT_MS = 30_000

export * from './paced-terminal-typing-measurement'

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

function readKeyArrivalSidecar(sidecarPath: string): Map<number, KeyArrivalRecord> {
  if (!existsSync(sidecarPath)) {
    return new Map()
  }
  return parseKeyArrivalSidecar(readFileSync(sidecarPath, 'utf8'))
}

function hasExpectedSeqs<T>(values: ReadonlyMap<number, T>, keyCount: number): boolean {
  for (let seq = 1; seq <= keyCount; seq += 1) {
    if (!values.has(seq)) {
      return false
    }
  }
  return true
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

  const plannedAtBySeq = new Map<number, number>()
  const sentAtBySeq = new Map<number, number>()
  const scheduleStartedAt = Date.now()
  try {
    for (let index = 0; index < options.keyCount; index++) {
      const seq = index + 1
      const plannedAt = scheduleStartedAt + index * options.keyCadenceMs
      plannedAtBySeq.set(seq, plannedAt)
      while (Date.now() < plannedAt) {
        await page.waitForTimeout(plannedAt - Date.now())
      }
      const actualDispatchAt = Date.now()
      sentAtBySeq.set(seq, actualDispatchAt)
      await page.keyboard.type(PACED_TYPING_CHARACTERS[index % PACED_TYPING_CHARACTERS.length])
    }
    // Wait out stragglers so a slow echo is measured, not dropped.
    const stragglerDeadline = Date.now() + ECHO_STRAGGLER_TIMEOUT_MS
    while (!hasExpectedSeqs(echoSeenAt, options.keyCount) && Date.now() < stragglerDeadline) {
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
  while (!hasExpectedSeqs(arrivals, options.keyCount) && Date.now() < sidecarDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    arrivals = readKeyArrivalSidecar(sidecarPath)
  }

  return buildPacedTypingMeasurement({
    keyCount: options.keyCount,
    plannedAtBySeq,
    sentAtBySeq,
    arrivals,
    echoSeenAt,
    maxTimerDriftMs
  })
}
