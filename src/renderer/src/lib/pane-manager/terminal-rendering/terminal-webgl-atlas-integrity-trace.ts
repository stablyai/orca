import type { AtlasCheckTrigger } from './terminal-webgl-atlas-integrity'

export type AtlasCheckTraceStage =
  | { stage: 'enter'; trigger: AtlasCheckTrigger }
  | { stage: 'admit' | 'deny'; trigger: AtlasCheckTrigger }
  | { stage: 'owner'; trigger: AtlasCheckTrigger; pane: number | null }
  | { stage: 'read'; x: number; y: number; result: string }
  | { stage: 'action'; trigger: AtlasCheckTrigger; outcome: string; reads: number; page?: number }

/** Session-only observation hook (unset in normal use); content-free stages. */
export function trace(entry: AtlasCheckTraceStage): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the optional session hook is installed outside the module and checked for callability below.
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
