import type { Page } from '@stablyai/playwright-test'

export type CodexEchoLatencySample = {
  index: number
  char: string
  /** keydown -> xterm finished parsing the echoed glyph (real echo latency). */
  keyToParseMs: number
  /** keydown -> xterm renderer painted the row carrying that glyph. */
  keyToRenderMs: number | null
}

export type CodexEchoProbeReport = {
  samples: CodexEchoLatencySample[]
  keysObserved: number
  parseEvents: number
  renderEvents: number
  cols: number
  rows: number
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __codexEchoProbe?: {
      report(): CodexEchoProbeReport
      dispose(): void
    }
  }
}

// Record in-renderer timestamps to exclude CDP serialization, IPC and polling cost from key-to-echo latency.
export async function installCodexEchoLatencyProbe(page: Page, target: string): Promise<void> {
  await page.evaluate((target) => {
    type PendingSample = {
      index: number
      char: string
      expected: string
      startedAt: number
      parsedAt: number | null
    }

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
      throw new Error('Codex echo probe: no active terminal pane')
    }
    const terminal = pane.terminal
    if (typeof terminal.onWriteParsed !== 'function') {
      throw new Error('Codex echo probe: xterm build has no onWriteParsed')
    }

    const samples: CodexEchoLatencySample[] = []
    const awaitingRender: { sample: CodexEchoLatencySample; startedAt: number }[] = []
    // Queue samples because one echo may still be pending when the next key arrives.
    const pending: PendingSample[] = []
    let keysObserved = 0
    let parseEvents = 0
    let renderEvents = 0

    // Join wrapped rows without separators so split echo tokens remain matchable.
    const viewportText = (): string => {
      const buffer = terminal.buffer.active
      let text = ''
      for (let row = 0; row < terminal.rows; row += 1) {
        text += buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
      }
      return text
    }

    const observeParse = (): void => {
      parseEvents += 1
      if (pending.length === 0) {
        return
      }
      const text = viewportText()
      // Credit every queued keystroke when one parse delivers several echoes.
      while (pending.length > 0 && text.includes(pending[0].expected)) {
        const entry = pending.shift()
        if (!entry) {
          break
        }
        entry.parsedAt = performance.now()
        const sample: CodexEchoLatencySample = {
          index: entry.index,
          char: entry.char,
          keyToParseMs: entry.parsedAt - entry.startedAt,
          keyToRenderMs: null
        }
        samples.push(sample)
        awaitingRender.push({ sample, startedAt: entry.startedAt })
      }
    }

    const observeRender = (): void => {
      renderEvents += 1
      const paintedAt = performance.now()
      for (const entry of awaitingRender.splice(0)) {
        entry.sample.keyToRenderMs = paintedAt - entry.startedAt
      }
    }

    // Capture on window before xterm forwards the key so t0 precedes all measured PTY work.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.length !== 1 || keysObserved >= target.length) {
        return
      }
      const index = keysObserved
      keysObserved += 1
      pending.push({
        index,
        char: target[index],
        expected: target.slice(0, index + 1),
        startedAt: performance.now(),
        parsedAt: null
      })
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    const parsedDisposable = terminal.onWriteParsed(observeParse)
    const renderDisposable = terminal.onRender(observeRender)

    window.__codexEchoProbe = {
      report: () => ({
        samples: [...samples],
        keysObserved,
        parseEvents,
        renderEvents,
        cols: terminal.cols,
        rows: terminal.rows
      }),
      dispose: () => {
        window.removeEventListener('keydown', onKeyDown, { capture: true })
        parsedDisposable.dispose()
        renderDisposable.dispose()
      }
    }
  }, target)
}

/** Drains every recorded sample in a single round-trip once typing has finished. */
export async function collectCodexEchoLatencyReport(page: Page): Promise<CodexEchoProbeReport> {
  return page.evaluate(() => {
    const probe = window.__codexEchoProbe
    if (!probe) {
      throw new Error('Codex echo probe was never installed')
    }
    const report = probe.report()
    probe.dispose()
    return report
  })
}

export type LatencyDistribution = {
  count: number
  p50: number
  p95: number
  max: number
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const rank = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)
  return sorted[Math.max(0, rank)]
}

export function summarizeLatencies(values: number[]): LatencyDistribution {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0
  }
}

export function formatDistribution(label: string, distribution: LatencyDistribution): string {
  return (
    `${label} n=${distribution.count} p50=${distribution.p50.toFixed(1)}ms ` +
    `p95=${distribution.p95.toFixed(1)}ms max=${distribution.max.toFixed(1)}ms`
  )
}
