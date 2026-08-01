import type { CodexBackfillPaneHoldState } from '../../../../shared/codex-backfill-status-types'
import type { CodexIndexingPaneState } from './codex-backfill-spawn-gate'

function toIndexingState(state: CodexBackfillPaneHoldState | null): CodexIndexingPaneState | null {
  if (!state || state.phase !== 'indexing') {
    return null
  }
  return { lastWatermark: state.lastWatermark }
}

/** Why: main owns gate enforcement (#11828); every pane — fresh or adopted — just mirrors its paneKey's hold state. */
export function subscribeToCodexBackfillPaneHold(
  paneKey: string,
  onState: (state: CodexIndexingPaneState | null) => void
): () => void {
  const api = window.api?.codexBackfill
  if (!api?.onPaneHoldChanged || !api?.paneHoldStatus) {
    return () => {}
  }
  let disposed = false
  void api
    .paneHoldStatus(paneKey)
    .then((state) => {
      if (!disposed && state && state.paneKey === paneKey) {
        onState(toIndexingState(state))
      }
    })
    .catch(() => {})
  const unsubscribe = api.onPaneHoldChanged((state) => {
    if (!disposed && state.paneKey === paneKey) {
      onState(toIndexingState(state))
    }
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
