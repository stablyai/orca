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

/** Opt-in visible WebGL cell/ink comparison detects persistent missing glyphs; capture presented pixels/model/atlas before recovery can erase evidence. Cmd/Ctrl+Shift+click captures unconditionally without recovery, covering ink-present failures such as bold collapse (STA-4042). */

const SAMPLE_INTERVAL_MS = 250
const SAMPLE_BURST_MS = 10_000
// Require persistent missing cells at the same coordinates; frame/scroll lag moves them.
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
    // Read compositor-presented pixels before any refresh can heal the failure; recover only after durable capture.
    const divergence = measure(internals, buffer)
    if (!divergence || divergence.textCells < MIN_TEXT_CELLS) {
      missingHistoryByPane.delete(paneKey)
      return
    }
    if (divergence.missPct < MISSING_PCT_THRESHOLD) {
      // Reset on subthreshold frames so isolated later spikes cannot masquerade as persistent divergence.
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
      // Cap large evidence captures per session while keeping recovery available after the budget is spent.
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

/** Capture one pane unconditionally and leave its broken state intact for further inspection. */
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
  // Manual capture must survive failed readback; PNG/probe data still provide evidence.
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
    // Failed persistence leaves the only evidence on screen; recovery would destroy it.
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
