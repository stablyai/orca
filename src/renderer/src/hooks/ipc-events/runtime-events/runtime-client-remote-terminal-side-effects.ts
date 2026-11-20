import { dispatchTerminalSideEffectBatch } from '@/components/terminal-pane/pty-transport/output/terminal-side-effect-facts-handler'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'

/** A host's terminal side effects, addressed to that host's ptys; false for any other event. */
export function applyRemoteTerminalSideEffects(
  environmentId: string,
  event: RuntimeClientEvent
): boolean {
  if (event.type !== 'terminalSideEffects') {
    return false
  }
  dispatchTerminalSideEffectBatch({
    ...event.batch,
    ptyId: toRemoteRuntimePtyId(event.batch.ptyId, environmentId)
  })
  return true
}
