import type { Page } from '@stablyai/playwright-test'

export type CodexEchoLatencySample = {
  index: number
  char: string
  /** keydown -> xterm finished parsing the echoed glyph (real echo latency). */
  keyToParseMs: number
  /** keydown -> xterm renderer painted the row carrying that glyph. */
  keyToRenderMs: number | null
}

export type CodexDataLatencySample = {
  index: number
  kind: 'text' | 'ime'
  /** `event.code`: `event.key` is the literal string 'Process' for every Pinyin/Cangjie keydown. */
  code: string
  /** keydown -> xterm emitted that keystroke's bytes on `onData` (composer-vs-onData delta). */
  keyToDataMs: number
  data: string
}

export type CodexEchoProbeReport = {
  samples: CodexEchoLatencySample[]
  /** Per-keystroke keydown->onData deltas, sampled DURING typing rather than after quiescence. */
  dataSamples: CodexDataLatencySample[]
  keysObserved: number
  imeKeysObserved: number
  parseEvents: number
  dataEvents: number
  /** `onData` emissions with no keydown to charge them to (paste, PTY-driven replies). */
  unattributedDataEvents: number
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

/**
 * Installs an in-renderer latency recorder on the active terminal pane, over two
 * independent arms:
 *  - echo: keydown -> `onWriteParsed` -> `onRender`, i.e. what the screen shows.
 *  - input: keydown -> `onData`, i.e. how fast the keystroke leaves the composer.
 * They answer different questions and neither substitutes for the other.
 *
 * Why in-page: polling a serialized buffer over CDP adds serialize + IPC +
 * poll-granularity cost to every sample, which swamped the signal it measured.
 * Timestamps here are taken inside the renderer with performance.now(), so the
 * measured window contains no cross-process work at all.
 */
export async function installCodexEchoLatencyProbe(page: Page, target: string): Promise<void> {
  await page.evaluate((target) => {
    type PendingSample = {
      index: number
      char: string
      expected: string
      startedAt: number
      parsedAt: number | null
    }

    type KeyStamp = {
      index: number
      kind: 'text' | 'ime'
      code: string
      startedAt: number
      charged: boolean
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
    if (typeof terminal.onData !== 'function') {
      throw new Error('Codex echo probe: xterm build has no onData')
    }

    const samples: CodexEchoLatencySample[] = []
    const dataSamples: CodexDataLatencySample[] = []
    const awaitingRender: {
      sample: CodexEchoLatencySample
      startedAt: number
    }[] = []
    // Why a queue, not one slot: a slow echo can still be outstanding when the
    // next key is pressed, and a single slot silently discards that sample.
    const pending: PendingSample[] = []
    let lastKey: KeyStamp | null = null
    let keysObserved = 0
    let imeKeysObserved = 0
    let parseEvents = 0
    let dataEvents = 0
    let unattributedDataEvents = 0
    let renderEvents = 0

    // Why concatenated without a separator: a composer line that wraps splits the
    // token across rows, and trailing-trimmed rows rejoin exactly at the break.
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
      // Why drain in order: one parse can land several queued keystrokes at
      // once, and each still gets credited against its own keydown timestamp.
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

    // Why charge to the LATEST keydown and not a FIFO head: composing jamo emit no
    // `onData` at all, so a queue would credit a committing keystroke's bytes to the
    // first keydown of the syllable and report the whole composition as its latency.
    // `charged` keeps only the first emission per key, since a commit that also opens
    // the next preedit fires twice for one press.
    const observeData = (data: string): void => {
      dataEvents += 1
      if (!lastKey || lastKey.charged) {
        unattributedDataEvents += 1
        return
      }
      lastKey.charged = true
      dataSamples.push({
        index: lastKey.index,
        kind: lastKey.kind,
        code: lastKey.code,
        keyToDataMs: performance.now() - lastKey.startedAt,
        data
      })
    }

    const observeRender = (): void => {
      renderEvents += 1
      const paintedAt = performance.now()
      for (const entry of awaitingRender.splice(0, awaitingRender.length)) {
        entry.sample.keyToRenderMs = paintedAt - entry.startedAt
      }
    }

    // Why not `key.length === 1`: an IME keydown carries no character. Pinyin and
    // Cangjie report `key: 'Process'` (length 7) on every press, so a length filter
    // drops 100% of those runs; the same shape the app itself branches on in
    // `src/renderer/src/lib/ime-composition-keyboard-event.ts`.
    const isImeKeyDown = (event: KeyboardEvent): boolean =>
      event.key === 'Process' || event.keyCode === 229 || event.isComposing

    // Why window capture: a listener on an ancestor in the capture phase is
    // guaranteed to run before xterm's own keydown handler forwards to the PTY,
    // so t0 is stamped before any of the work being measured starts.
    const onKeyDown = (event: KeyboardEvent): void => {
      const ime = isImeKeyDown(event)
      if (!ime && event.key.length !== 1) {
        return
      }
      const startedAt = performance.now()
      // Why IME keys stay out of `pending`: the echo arm matches a prefix of `target`,
      // and N jamo presses produce one syllable, so per-keystroke prefix matching
      // would charge each syllable to the wrong keydown and never drain the queue.
      if (ime) {
        lastKey = {
          index: imeKeysObserved,
          kind: 'ime',
          code: event.code,
          startedAt,
          charged: false
        }
        imeKeysObserved += 1
        return
      }
      if (keysObserved >= target.length) {
        return
      }
      const index = keysObserved
      keysObserved += 1
      lastKey = {
        index,
        kind: 'text',
        code: event.code,
        startedAt,
        charged: false
      }
      pending.push({
        index,
        char: target[index],
        expected: target.slice(0, index + 1),
        startedAt,
        parsedAt: null
      })
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    const parsedDisposable = terminal.onWriteParsed(observeParse)
    const dataDisposable = terminal.onData(observeData)
    const renderDisposable = terminal.onRender(observeRender)

    window.__codexEchoProbe = {
      report: () => ({
        samples: [...samples],
        dataSamples: [...dataSamples],
        keysObserved,
        imeKeysObserved,
        parseEvents,
        dataEvents,
        unattributedDataEvents,
        renderEvents,
        cols: terminal.cols,
        rows: terminal.rows
      }),
      dispose: () => {
        window.removeEventListener('keydown', onKeyDown, { capture: true })
        parsedDisposable.dispose()
        dataDisposable.dispose()
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

/**
 * Why this throws instead of returning zeros: an empty sample set used to summarise as
 * `p50/p95/max = 0`, i.e. *perfect* latency, so every `toBeLessThan` threshold passed and a run
 * that measured nothing looked like the best run ever recorded. The existing consumer is safe only
 * because a separate line asserts the sample count. Refusing here makes that guard unnecessary
 * rather than load-bearing.
 */
export function summarizeLatencies(values: number[]): LatencyDistribution {
  if (values.length === 0) {
    throw new Error(
      'summarizeLatencies received 0 samples — a distribution over no data would report 0ms ' +
        'and pass every latency threshold. Assert the sample count before summarising.'
    )
  }
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
