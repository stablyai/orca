import { PanelRight, PanelRightClose } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { DEFAULT_CROSS_WORKSPACE_PANE_FRACTION } from '../../../../shared/workspace-view/cross-workspace-pane'
import {
  canShowInCrossWorkspacePane,
  isShownInCrossWorkspacePane
} from './cross-workspace-pane-tab'

/** Tab menu entry that keeps the tab visible beside every workspace, or returns it. */
export function CrossWorkspacePaneMenuItem({
  worktreeId,
  unifiedTabId
}: {
  worktreeId: string
  unifiedTabId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const eligible = useAppStore((s) => {
    const tab = s.unifiedTabsByWorktree[worktreeId]?.find(
      (candidate) => candidate.id === unifiedTabId
    )
    return tab !== undefined && canShowInCrossWorkspacePane(tab)
  })
  const shown = useAppStore((s) => isShownInCrossWorkspacePane(s, worktreeId, unifiedTabId))
  const setPane = useAppStore((s) => s.setCrossWorkspacePane)
  if (!eligible) {
    return null
  }
  return (
    <ContextMenuItem
      onSelect={() => {
        const current = useAppStore.getState().crossWorkspacePane
        setPane(
          shown
            ? null
            : {
                worktreeId,
                tabId: unifiedTabId,
                fraction: current?.fraction ?? DEFAULT_CROSS_WORKSPACE_PANE_FRACTION
              }
        )
      }}
    >
      {shown ? (
        <PanelRightClose className="size-3.5 shrink-0" />
      ) : (
        <PanelRight className="size-3.5 shrink-0" />
      )}
      {shown
        ? t(
            'auto.components.cross.workspace.pane.CrossWorkspacePaneMenuItem.removeFromSidePane',
            'Remove from Side Pane'
          )
        : t(
            'auto.components.cross.workspace.pane.CrossWorkspacePaneMenuItem.keepInSidePane',
            'Keep in Side Pane'
          )}
    </ContextMenuItem>
  )
}
