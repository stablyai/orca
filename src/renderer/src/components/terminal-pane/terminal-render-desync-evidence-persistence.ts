import type { SentinelEvidence } from './terminal-render-desync-sentinel'

/**
 * Durable persistence for render-desync captures, split from the sentinel so
 * the detection loop, trigger gestures and storage lifecycles stay separately
 * readable. Failure contract: a failed write must leave the live pane intact —
 * recovering after a failed write would destroy the only evidence without
 * producing a durable capture, so callers gate recovery on the returned
 * directory.
 */
export async function persistCorruptEvidence(entry: SentinelEvidence): Promise<string | null> {
  const pngDataUrl = entry.livePngDataUrl
  const bufferText = entry.bufferText
  try {
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
        trigger: entry.trigger,
        rendererState: entry.rendererState,
        weightProbe: entry.weightProbe,
        bufferText
      }
    })
    entry.persistedDirectory = persisted.directory
    return persisted.directory
  } catch (error) {
    console.error('[terminal] could not persist render-desync evidence; leaving pane intact', error)
    return null
  } finally {
    // Why: persistence owns a successful payload, while a failed write leaves
    // the live pane intact; neither path should retain duplicate full-canvas data.
    entry.livePngDataUrl = undefined
    entry.bufferText = undefined
  }
}

export async function persistHealedReference(
  captureId: string,
  canvas: HTMLCanvasElement
): Promise<void> {
  try {
    await window.api.app.writeTerminalRenderDesyncEvidence({
      captureId,
      phase: 'healed',
      pngDataUrl: canvas.toDataURL(),
      metadata: { when: Date.now() }
    })
  } catch (error) {
    console.error('[terminal] could not persist healed render reference', error)
  }
}

export function createCaptureId(paneKey: string): string {
  const panePart = paneKey.replace(/[^a-zA-Z0-9_-]/g, '-')
  const nonce = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `${Date.now()}-${panePart}-${nonce}`
}
