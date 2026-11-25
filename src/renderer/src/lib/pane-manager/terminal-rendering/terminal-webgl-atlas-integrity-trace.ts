import type { AtlasCheckTrigger } from './terminal-webgl-atlas-integrity'

export type AtlasCheckTraceStage =
  | { stage: 'enter'; trigger: AtlasCheckTrigger }
  | { stage: 'admit' | 'deny'; trigger: AtlasCheckTrigger }
  | { stage: 'owner'; trigger: AtlasCheckTrigger; pane: number | null }
  | { stage: 'read'; x: number; y: number; result: string }
  | { stage: 'action'; trigger: AtlasCheckTrigger; outcome: string; reads: number; page?: number }

/** Session-only observation hook (unset in normal use); content-free stages. */
export function trace(entry: AtlasCheckTraceStage): void {
  const hook = (globalThis as { __orcaAtlasIntegrityTrace?: (entry: AtlasCheckTraceStage) => void })
    .__orcaAtlasIntegrityTrace
  if (typeof hook === 'function') {
    try {
      hook(entry)
    } catch {
      // Observation only.
    }
  }
}
