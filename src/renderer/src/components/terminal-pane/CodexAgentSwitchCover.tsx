import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { useCodexAgentSwitching } from '@/lib/codex-child-row-view'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

/** Opaque, in the terminal's own colour, so the typed /subagents command, its printed note and the picker never show. */
export function CodexAgentSwitchCover({
  tabId,
  leafId,
  background
}: {
  tabId: string
  leafId: string
  background: string
}): React.JSX.Element | null {
  if (!useCodexAgentSwitching(makePaneKey(tabId, leafId))) {
    return null
  }
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center gap-2 text-sm text-muted-foreground"
      style={{ background }}
      role="status"
      aria-live="polite"
    >
      <LoadingSpinner className="size-4" />
      {translate(
        'auto.components.terminal.pane.CodexAgentSwitchCover.switching',
        'Switching agent…'
      )}
    </div>
  )
}
