import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { isShownInCrossWorkspacePane } from './cross-workspace-pane-tab'

/** Fills a tab's own pane while the side pane has its terminal: one terminal draws in one place. */
export function CrossWorkspacePaneHomeNotice({
  worktreeId,
  tabId
}: {
  worktreeId: string
  tabId: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const shown = useAppStore((s) => isShownInCrossWorkspacePane(s, worktreeId, tabId))
  const setPane = useAppStore((s) => s.setCrossWorkspacePane)
  if (!shown) {
    return null
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      {t(
        'auto.components.cross.workspace.pane.CrossWorkspacePaneHomeNotice.inSidePane',
        'This tab is in the side pane.'
      )}
      <Button variant="outline" size="sm" onClick={() => setPane(null)}>
        {t(
          'auto.components.cross.workspace.pane.CrossWorkspacePaneHomeNotice.showHere',
          'Show here'
        )}
      </Button>
    </div>
  )
}
