import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import {
  forEachLivePaneForDesyncSentinel,
  resetAndRefreshAllTerminalWebglAtlases
} from '@/lib/pane-manager/pane-manager-registry'
import {
  createCaptureId,
  persistCorruptEvidence,
  persistHealedReference
} from './terminal-render-desync-evidence-persistence'
import {
  activeBuffer,
  bufferSnapshot,
  measureDivergence,
  missingSetsOverlap,
  reachRenderInternals,
  releaseRenderDesyncReadback,
  type SentinelRendererState,
  type SentinelRenderInternals
} from './terminal-render-desync-frame'
import {
  readSentinelWeightProbe,
  type SentinelWeightProbe
} from './terminal-render-desync-weight-probe'

/**
 * Flag-gated render-desync sentinel for WebGL terminal panes.
 *
 * Detects the "buffer is correct but the canvas renders stale/garbled glyphs"
 * class of bug (shared glyph-atlas desync) by comparing, per visible pane, the
 * cells the xterm buffer says hold glyphs against the ink actually present on
 * the WebGL canvas. Modifier-clicks start a short burst that reads the
 * compositor-presented canvas before any forced redraw can heal or destroy the
 * failure. A confirmed trip writes the pixels, buffer, and atlas/model versions
 * to local app data before running the shared-atlas recovery.
 *
 * Cmd/Ctrl+Shift+click (see terminal-render-desync-trigger.ts) captures the
 * clicked pane immediately and unconditionally — no divergence gate and no
 * recovery afterwards — for states the ink detector cannot see, e.g. the
 * bold-collapse bug (STA-4042 family) where every cell has ink but regular
 * text rasterized at the bold weight.
 */

const SAMPLE_INTERVAL_MS = 250
const SAMPLE_BURST_MS = 10_000
// A real desync is pinned to fixed screen cells; scroll/frame lag moves around.
// Require the same cells missing across this many consecutive samples.
const PERSISTENT_SAMPLES = 2
const MIN_TEXT_CELLS = 200
const MISSING_PCT_THRESHOLD = 8
const MAX_EVIDENCE_ENTRIES = 4

export type SentinelEvidence = {
  captureId: string
  paneKey: string
  when: number
  trigger: 'divergence' | 'manual'
  divergence: { textCells: number; missing: number; missPct: number }
  paused: boolean
  rendererState: SentinelRendererState
  weightProbe: SentinelWeightProbe
  livePngDataUrl?: string
  bufferText?: string
  persistedDirectory?: string
}

type SentinelPane = {
  id: number
  terminal: unknown
}

const missingHistoryByPane = new Map<string, Set<number>[]>()
const pendingPaneKeys = new Set<string>()
const healedCaptureTimeoutIds = new Set<ReturnType<typeof setTimeout>>()
const evidence: SentinelEvidence[] = []
let burstIntervalId: ReturnType<typeof setInterval> | null = null
let burstTimeoutId: ReturnType<typeof setTimeout> | null = null
let burstTerminal: unknown = null

export function getRenderDesyncEvidence(): SentinelEvidence[] {
  return evidence
}

export function sampleRenderDesyncOnce(
  // Test seam: happy-dom has no 2D canvas, so tests inject crafted divergences.
  measure: typeof measureDivergence = measureDivergence
): void {
  forEachLivePaneForDesyncSentinel((paneKey, pane) => {
    const terminal = (pane as SentinelPane).terminal
    if ((burstTerminal && terminal !== burstTerminal) || pendingPaneKeys.has(paneKey)) {
      return
    }
    const internals = reachRenderInternals(terminal)
    if (!internals || internals.isPaused) {
      missingHistoryByPane.delete(paneKey)
      return
    }
    const buffer = activeBuffer(terminal)
    if (!buffer) {
      return
    }
    // Why: the field failure can heal on any refresh. Read the canvas exactly
    // as Chromium presented it; recovery happens only after durable evidence.
    const divergence = measure(internals, buffer)
    if (!divergence || divergence.textCells < MIN_TEXT_CELLS) {
      missingHistoryByPane.delete(paneKey)
      return
    }
    if (divergence.missPct < MISSING_PCT_THRESHOLD) {
      // Why: only consecutive threshold breaches prove persistence; retaining a
      // subthreshold frame lets one later spike create a false field capture.
      missingHistoryByPane.delete(paneKey)
      return
    }
    const history = missingHistoryByPane.get(paneKey) ?? []
    history.push(divergence.missingCells)
    while (history.length > PERSISTENT_SAMPLES) {
      history.shift()
    }
    missingHistoryByPane.set(paneKey, history)

    if (history.length < PERSISTENT_SAMPLES) {
      return
    }
    for (let i = 1; i < history.length; i++) {
      if (!missingSetsOverlap(history[i - 1], history[i])) {
        return
      }
    }

    missingHistoryByPane.delete(paneKey)
    recordTerminalWebglDiagnostic('webgl-render-desync', {
      paneKey,
      textCells: divergence.textCells,
      missing: divergence.missing,
      missPct: Math.round(divergence.missPct * 10) / 10
    })
    if (evidence.length >= MAX_EVIDENCE_ENTRIES) {
      // Why: captures can contain full terminal canvases and buffer contents.
      // Keep recovery available after the per-session evidence budget is spent.
      console.warn(`[terminal] render desync detected on pane ${paneKey}; capture budget exhausted`)
      resetAndRefreshAllTerminalWebglAtlases('render-desync')
      stopRenderDesyncSampleBurst()
      return
    }
    const entry = buildEvidenceEntry(paneKey, terminal, internals, divergence, 'divergence')
    console.warn(
      `[terminal] render desync detected on pane ${paneKey} ` +
        `(${divergence.missing}/${divergence.textCells} cells, ${divergence.missPct.toFixed(1)}%) — persisting evidence`
    )
    void persistEntry(entry, internals, { recover: true })
  })
}

/**
 * Unconditional capture of one pane, bypassing the divergence detector. No
 * recovery afterwards: the caller wants the broken state left on screen to
 * poke at, and recovery would also destroy any not-yet-understood layer state.
 */
export function captureRenderDesyncNow(paneKey: string, pane: unknown): void {
  const terminal = (pane as SentinelPane).terminal
  if (pendingPaneKeys.has(paneKey) || evidence.length >= MAX_EVIDENCE_ENTRIES) {
    console.warn(`[terminal] manual desync capture skipped for ${paneKey}: budget or in flight`)
    return
  }
  const internals = reachRenderInternals(terminal)
  if (!internals) {
    console.warn(`[terminal] manual desync capture failed for ${paneKey}: no renderer internals`)
    return
  }
  // Why tolerant: the manual gesture must produce a capture even when the
  // canvas readback path fails — the PNG and probe fields are the payload.
  let measured: ReturnType<typeof measureDivergence> = null
  try {
    const buffer = activeBuffer(terminal)
    measured = buffer && measureDivergence(internals, buffer)
  } catch {
    measured = null
  }
  const divergence = measured ?? {
    textCells: 0,
    missing: 0,
    missPct: 0,
    missingCells: new Set<number>()
  }
  const entry = buildEvidenceEntry(paneKey, terminal, internals, divergence, 'manual')
  recordTerminalWebglDiagnostic('webgl-render-desync-manual-capture', {
    paneKey,
    boldTextCells: entry.weightProbe.boldTextCells,
    totalTextCells: entry.weightProbe.totalTextCells,
    optionsFontWeight: entry.weightProbe.optionsFontWeight,
    atlasConfigFontWeight: entry.weightProbe.atlasConfigFontWeight
  })
  console.warn(`[terminal] manual render-desync capture on pane ${paneKey} — persisting evidence`)
  void persistEntry(entry, internals, { recover: false })
}

function buildEvidenceEntry(
  paneKey: string,
  terminal: unknown,
  internals: SentinelRenderInternals,
  divergence: { textCells: number; missing: number; missPct: number },
  trigger: SentinelEvidence['trigger']
): SentinelEvidence {
  pendingPaneKeys.add(paneKey)
  const buffer = activeBuffer(terminal)
  const entry: SentinelEvidence = {
    captureId: createCaptureId(paneKey),
    paneKey,
    when: Date.now(),
    trigger,
    divergence: {
      textCells: divergence.textCells,
      missing: divergence.missing,
      missPct: divergence.missPct
    },
    paused: internals.isPaused,
    rendererState: internals.rendererState,
    weightProbe: readSentinelWeightProbe(terminal, buffer, internals.rows, internals.cols),
    livePngDataUrl: internals.canvas.toDataURL(),
    bufferText: buffer ? bufferSnapshot(buffer, internals.rows) : ''
  }
  evidence.push(entry)
  return entry
}

async function persistEntry(
  entry: SentinelEvidence,
  internals: SentinelRenderInternals,
  { recover }: { recover: boolean }
): Promise<void> {
  const directory = await persistCorruptEvidence(entry)
  if (directory == null) {
    // Why: a failed write must leave the bad pixels intact; recovering here
    // would destroy the only evidence without producing a durable capture.
    const entryIndex = evidence.indexOf(entry)
    if (entryIndex !== -1) {
      evidence.splice(entryIndex, 1)
    }
    pendingPaneKeys.delete(entry.paneKey)
    return
  }
  if (!recover) {
    pendingPaneKeys.delete(entry.paneKey)
    return
  }
  resetAndRefreshAllTerminalWebglAtlases('render-desync')
  const timeoutId = setTimeout(() => {
    healedCaptureTimeoutIds.delete(timeoutId)
    void persistHealedReference(entry.captureId, internals.canvas).finally(() =>
      pendingPaneKeys.delete(entry.paneKey)
    )
  }, SAMPLE_INTERVAL_MS)
  healedCaptureTimeoutIds.add(timeoutId)
}

export function stopTerminalRenderDesyncSentinelForTesting(): void {
  stopRenderDesyncSampleBurst()
  missingHistoryByPane.clear()
  pendingPaneKeys.clear()
  for (const timeoutId of healedCaptureTimeoutIds) {
    clearTimeout(timeoutId)
  }
  healedCaptureTimeoutIds.clear()
  evidence.length = 0
}

export function startRenderDesyncSampleBurst(terminal: unknown): void {
  stopRenderDesyncSampleBurst()
  burstTerminal = terminal
  sampleRenderDesyncOnce()
  burstIntervalId = setInterval(sampleRenderDesyncOnce, SAMPLE_INTERVAL_MS)
  burstTimeoutId = setTimeout(stopRenderDesyncSampleBurst, SAMPLE_BURST_MS)
}

export function stopRenderDesyncSampleBurst(): void {
  if (burstIntervalId != null) {
    clearInterval(burstIntervalId)
    burstIntervalId = null
  }
  if (burstTimeoutId != null) {
    clearTimeout(burstTimeoutId)
    burstTimeoutId = null
  }
  burstTerminal = null
  missingHistoryByPane.clear()
  releaseRenderDesyncReadback()
}
