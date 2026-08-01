import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CodexIndexingPaneState } from './codex-backfill-pane-hold'

/** Extracts a YYYY-MM-DD hint from the backfill cursor (sessions/YYYY/MM/DD/rollout-*.jsonl). */
export function formatCodexIndexingProgress(lastWatermark: string | null): string | null {
  const match = /sessions[/\\](\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/.exec(lastWatermark ?? '')
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/** In-pane wait state while the codex session index finishes (#11828 spawn gate). */
export function CodexIndexingOverlay({
  state
}: {
  state: CodexIndexingPaneState
}): React.JSX.Element {
  const progressDate = formatCodexIndexingProgress(state.lastWatermark)
  return (
    <div className="absolute inset-x-3 bottom-3 z-50 flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-4 shrink-0 animate-spin" />
      <div className="min-w-0">
        <div>
          {translate(
            'auto.components.terminal.pane.CodexIndexingOverlay.indexing',
            'Indexing Codex session history…'
          )}
        </div>
        <div>
          {progressDate
            ? translate(
                'auto.components.terminal.pane.CodexIndexingOverlay.progressThrough',
                'Indexed through {{value0}}. Codex will start automatically when indexing finishes.',
                { value0: progressDate }
              )
            : translate(
                'auto.components.terminal.pane.CodexIndexingOverlay.autoStart',
                'Codex will start automatically when indexing finishes.'
              )}
        </div>
      </div>
    </div>
  )
}
