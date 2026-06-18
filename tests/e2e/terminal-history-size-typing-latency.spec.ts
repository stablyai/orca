import type { Page } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  sendToTerminal
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Reproduction harness for issue #5096: terminal output delay and input lag
// reported to grow with session history and disappear after compacting/clearing
// the agent session. Measures keypress→echo latency through the full pipeline
// (renderer keyboard → PTY → echo → xterm paint-adjacent buffer read) at three
// scrollback fills. The fill also keeps the session continuously dirty, so
// daemon checkpoint serialization (every 5s) lands inside the sampling window
// exactly as it does in real agent sessions.
const KEY_LATENCY_SAMPLES = 'abcdefghijklmnop'
const MAX_MEDIAN_KEY_LATENCY_MS = 250
const MAX_WORST_KEY_LATENCY_MS = 1_000
const FILL_DONE_TIMEOUT_MS = 240_000
const FILL_PHASES = [10_000, 40_000] as const

async function readActiveTerminalBufferRows(page: Page): Promise<number> {
  return page.evaluate(() => {
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
    return pane?.terminal.buffer.active.length ?? -1
  })
}

function historyEchoScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
let fillPhase = 0
const fills = [${FILL_PHASES.join(', ')}]
const interrupt = String.fromCharCode(3)

function agentLine(i) {
  const color = 30 + (i % 8)
  if (i % 3 === 0) {
    return '\\x1b[1;' + color + 'm\\u25cf Tool call ' + i + '\\x1b[0m (src/example/file-' + (i % 97) + '.ts)\\r\\n'
  }
  if (i % 3 === 1) {
    return '\\x1b[' + color + 'm\\u2502\\x1b[0m  ' + 'response token '.repeat(1 + (i % 5)) + '#' + i + '\\r\\n'
  }
  return '  \\x1b[32m+\\x1b[0m line ' + i + ': ' + 'x'.repeat(10 + (i % 60)) + '\\r\\n'
}

function runFill() {
  const phase = fillPhase
  const count = fills[phase - 1]
  let i = 0
  const writeMore = () => {
    while (i < count) {
      const ok = process.stdout.write(agentLine(i))
      i += 1
      if (!ok) {
        process.stdout.once('drain', writeMore)
        return
      }
    }
    process.stdout.write('\\r\\nHIST_FILL_DONE_${runId}_' + phase + '\\r\\n')
  }
  writeMore()
}

process.stdout.write('\\x1b]0;Terminal history-size benchmark\\x07')
process.stdout.write('HIST_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '!') {
      fillPhase += 1
      runFill()
      continue
    }
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    process.stdout.write('\\r\\x1b[2KEcho ' + seq + ': ' + char + ' HIST_KEY_${runId}_' + seq + '\\n')
  }
})
`
}

// Why not getTerminalContent: that helper serializes the entire buffer per
// poll (~1.2s at 50k rows, on the renderer main thread), which both inflates
// the measured latency and causes the very lag this spec quantifies. Read only
// the trailing rows so measurement overhead stays constant across fills.
const MARKER_SCAN_TRAILING_ROWS = 80

async function recentTerminalTextIncludes(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(
    ({ marker, trailingRows }) => {
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
      if (!pane) {
        return false
      }
      const buffer = pane.terminal.buffer.active
      const start = Math.max(0, buffer.length - trailingRows)
      for (let row = buffer.length - 1; row >= start; row -= 1) {
        const line = buffer.getLine(row)?.translateToString(true) ?? ''
        if (line.includes(marker)) {
          return true
        }
      }
      return false
    },
    { marker, trailingRows: MARKER_SCAN_TRAILING_ROWS }
  )
}

async function waitForMarkerLatency(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (await recentTerminalTextIncludes(page, marker)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`)
}

async function waitForRecentTerminalMarker(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<void> {
  await waitForMarkerLatency(page, marker, timeoutMs)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

type PhaseLatency = {
  label: string
  bufferRows: number
  medianMs: number
  worstMs: number
  samples: number[]
}

async function measureTypingLatency(
  page: Page,
  runId: string,
  label: string,
  startSeq: number
): Promise<{ phase: PhaseLatency; nextSeq: number }> {
  const latencies: number[] = []
  let seq = startSeq
  for (const char of KEY_LATENCY_SAMPLES) {
    seq += 1
    const marker = `HIST_KEY_${runId}_${seq}`
    const start = performance.now()
    await page.keyboard.type(char)
    await waitForMarkerLatency(page, marker, MAX_WORST_KEY_LATENCY_MS * 5)
    latencies.push(performance.now() - start)
  }
  return {
    phase: {
      label,
      bufferRows: await readActiveTerminalBufferRows(page),
      medianMs: median(latencies),
      worstMs: Math.max(...latencies),
      samples: latencies
    },
    nextSeq: seq
  }
}

test.describe('Terminal typing latency vs scrollback history size', () => {
  test('typing stays responsive as terminal history grows', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.setTimeout(900_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-history-benchmark-${runId}.mjs`)
    writeFileSync(scriptPath, historyEchoScript(runId))
    let commandSent = false
    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      commandSent = true
      await waitForRecentTerminalMarker(orcaPage, `HIST_READY_${runId}`, 10_000)
      await focusActiveTerminalInput(orcaPage)

      const phases: PhaseLatency[] = []
      let seq = 0

      const baseline = await measureTypingLatency(orcaPage, runId, 'empty history', seq)
      phases.push(baseline.phase)
      seq = baseline.nextSeq

      for (const [phaseIndex] of FILL_PHASES.entries()) {
        await orcaPage.keyboard.type('!')
        await waitForRecentTerminalMarker(
          orcaPage,
          `HIST_FILL_DONE_${runId}_${phaseIndex + 1}`,
          FILL_DONE_TIMEOUT_MS
        )
        // Let the renderer drain queued output and let one daemon checkpoint
        // tick land before sampling, mirroring steady-state agent sessions.
        await orcaPage.waitForTimeout(2_000)
        await focusActiveTerminalInput(orcaPage)
        const cumulativeRows = FILL_PHASES.slice(0, phaseIndex + 1).reduce(
          (total, rows) => total + rows,
          0
        )
        const measured = await measureTypingLatency(
          orcaPage,
          runId,
          `after ${cumulativeRows} history rows`,
          seq
        )
        phases.push(measured.phase)
        seq = measured.nextSeq
      }

      // Why stdout too: the list reporter does not surface annotations, and
      // the per-phase numbers are the deliverable of this harness.
      process.stdout.write(
        `\n[history-latency] ${JSON.stringify(
          phases.map(({ label, bufferRows, medianMs, worstMs }) => ({
            label,
            bufferRows,
            medianMs: Math.round(medianMs * 10) / 10,
            worstMs: Math.round(worstMs * 10) / 10
          }))
        )}\n`
      )
      for (const phase of phases) {
        testInfo.annotations.push({
          type: 'terminal-history-typing-latency',
          description:
            `${phase.label}: bufferRows=${phase.bufferRows} median=${phase.medianMs.toFixed(1)}ms ` +
            `worst=${phase.worstMs.toFixed(1)}ms samples=${phase.samples
              .map((value) => value.toFixed(1))
              .join(',')}`
        })
      }

      for (const phase of phases) {
        expect(
          phase.medianMs,
          `${phase.label}: median latency regressed with history size`
        ).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
        expect(
          phase.worstMs,
          `${phase.label}: worst latency regressed with history size`
        ).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
      }
    } finally {
      if (commandSent) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })
})
