import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { useCodexAgentSwitching } from '@/lib/agent-session/navigation/codex-child-row-view'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

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
  const t = useTranslate()
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
      {t('auto.components.terminal.pane.CodexAgentSwitchCover.switching', 'Switching agent…')}
    </div>
  )
}
