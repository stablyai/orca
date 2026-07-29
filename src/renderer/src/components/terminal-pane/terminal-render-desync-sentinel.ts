import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import {
  forEachLivePaneForDesyncSentinel,
  resetAndRefreshAllTerminalWebglAtlases
} from '@/lib/pane-manager/pane-manager-registry'
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
 * Off by default; enabled via localStorage so a production build can arm it
 * from DevTools without a settings-schema change:
 *   localStorage.setItem('orca:render-desync-sentinel', '1')  // then reload
 */

export const RENDER_DESYNC_SENTINEL_FLAG = 'orca:render-desync-sentinel'
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
  divergence: { textCells: number; missing: number; missPct: number }
  paused: boolean
  rendererState: SentinelRendererState
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
let clickListener: ((event: MouseEvent) => void) | null = null
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
      resetAndRefreshAllTerminalWebglAtlases()
      stopSampleBurst()
      return
    }
    pendingPaneKeys.add(paneKey)
    const entry: SentinelEvidence = {
      captureId: createCaptureId(paneKey),
      paneKey,
      when: Date.now(),
      divergence: {
        textCells: divergence.textCells,
        missing: divergence.missing,
        missPct: divergence.missPct
      },
      paused: internals.isPaused,
      rendererState: internals.rendererState,
      livePngDataUrl: internals.canvas.toDataURL(),
      bufferText: bufferSnapshot(buffer, internals.rows)
    }
    evidence.push(entry)
    console.warn(
      `[terminal] render desync detected on pane ${paneKey} ` +
        `(${divergence.missing}/${divergence.textCells} cells, ${divergence.missPct.toFixed(1)}%) — persisting evidence`
    )
    void persistEvidenceThenRecover(entry, internals)
  })
}

export function maybeStartTerminalRenderDesyncSentinel(): void {
  if (clickListener != null) {
    return
  }
  let enabled = false
  try {
    enabled = globalThis.localStorage?.getItem(RENDER_DESYNC_SENTINEL_FLAG) === '1'
  } catch {
    enabled = false
  }
  if (!enabled) {
    return
  }
  clickListener = (event) => {
    const isMac = navigator.userAgent.includes('Mac')
    if (event.button !== 0 || (isMac ? !event.metaKey : !event.ctrlKey)) {
      return
    }
    const target = event.target
    if (!(target instanceof Node)) {
      return
    }
    let clickedTerminal: unknown = null
    forEachLivePaneForDesyncSentinel((_paneKey, pane) => {
      const terminal = (pane as SentinelPane).terminal as { element?: HTMLElement }
      if (terminal.element?.contains(target)) {
        clickedTerminal = terminal
      }
    })
    if (clickedTerminal) {
      startSampleBurst(clickedTerminal)
    }
  }
  document.addEventListener('mouseup', clickListener, true)
  console.warn('[terminal] render-desync sentinel armed (10s post-link bursts)')
}

export function stopTerminalRenderDesyncSentinelForTesting(): void {
  stopSampleBurst()
  if (clickListener != null) {
    document.removeEventListener('mouseup', clickListener, true)
    clickListener = null
  }
  missingHistoryByPane.clear()
  pendingPaneKeys.clear()
  for (const timeoutId of healedCaptureTimeoutIds) {
    clearTimeout(timeoutId)
  }
  healedCaptureTimeoutIds.clear()
  evidence.length = 0
}

function createCaptureId(paneKey: string): string {
  const panePart = paneKey.replace(/[^a-zA-Z0-9_-]/g, '-')
  const nonce = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `${Date.now()}-${panePart}-${nonce}`
}

function startSampleBurst(terminal: unknown): void {
  stopSampleBurst()
  burstTerminal = terminal
  sampleRenderDesyncOnce()
  burstIntervalId = setInterval(sampleRenderDesyncOnce, SAMPLE_INTERVAL_MS)
  burstTimeoutId = setTimeout(stopSampleBurst, SAMPLE_BURST_MS)
}

function stopSampleBurst(): void {
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

async function persistEvidenceThenRecover(
  entry: SentinelEvidence,
  internals: SentinelRenderInternals
): Promise<void> {
  try {
    const pngDataUrl = entry.livePngDataUrl
    const bufferText = entry.bufferText
    if (!pngDataUrl || bufferText == null) {
      throw new Error('Render-desync evidence payload was released before persistence')
    }
    const persisted = await window.api.app.writeTerminalRenderDesyncEvidence({
      captureId: entry.captureId,
      phase: 'corrupt',
      pngDataUrl,
      metadata: {
        paneKey: entry.paneKey,
        when: entry.when,
        divergence: entry.divergence,
        paused: entry.paused,
        rendererState: entry.rendererState,
        bufferText
      }
    })
    entry.persistedDirectory = persisted.directory
  } catch (error) {
    // Why: a failed write must leave the bad pixels intact; recovering here
    // would destroy the only evidence without producing a durable capture.
    console.error('[terminal] could not persist render-desync evidence; leaving pane intact', error)
    pendingPaneKeys.delete(entry.paneKey)
    return
  } finally {
    // Why: persistence owns a successful payload, while a failed write leaves
    // the live pane intact; neither path should retain duplicate full-canvas data.
    entry.livePngDataUrl = undefined
    entry.bufferText = undefined
  }

  resetAndRefreshAllTerminalWebglAtlases()
  const timeoutId = setTimeout(() => {
    healedCaptureTimeoutIds.delete(timeoutId)
    void window.api.app
      .writeTerminalRenderDesyncEvidence({
        captureId: entry.captureId,
        phase: 'healed',
        pngDataUrl: internals.canvas.toDataURL(),
        metadata: { when: Date.now() }
      })
      .catch((error) =>
        console.error('[terminal] could not persist healed render reference', error)
      )
      .finally(() => pendingPaneKeys.delete(entry.paneKey))
  }, SAMPLE_INTERVAL_MS)
  healedCaptureTimeoutIds.add(timeoutId)
}
