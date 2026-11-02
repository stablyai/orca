import type { SentinelEvidence } from './terminal-render-desync-sentinel'
import { createBrowserUuid } from '@/lib/browser-uuid'

/** Persist before recovery; failed writes leave the live pane as the only evidence, so callers recover only with a returned capture directory. */
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
    // Release duplicate canvas data after either persistence or failure; the live pane remains intact on failure.
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

/** Use only leaf identity plus UUID nonce to fit main’s 120-character capture-ID cap; full tab:leaf keys overflow it. */
const MAX_CAPTURE_ID_PANE_PART_LENGTH = 40

export function createCaptureId(paneKey: string): string {
  const panePart = paneKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-MAX_CAPTURE_ID_PANE_PART_LENGTH)
  const nonce = createBrowserUuid()
  return `${Date.now()}-${panePart}-${nonce}`
}
