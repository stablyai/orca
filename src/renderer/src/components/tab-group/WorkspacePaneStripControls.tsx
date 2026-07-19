import { Maximize2, Minimize2, X } from 'lucide-react'
import { useAppStore } from '../../store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Maximize/restore + send-back buttons for a side-by-side workspace pane,
 *  rendered in the pane's top-right group strip beside the native controls. */
export default function WorkspacePaneStripControls({
  worktreeId,
  mode,
  buttonClassName
}: {
  worktreeId: string
  mode: 'grid' | 'maximized'
  buttonClassName: string
}): React.JSX.Element {
  const maximized = mode === 'maximized'
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={
              maximized
                ? translate('auto.components.tab.group.TabGroupPanel.restoreSplit', 'Restore split')
                : translate('auto.components.tab.group.TabGroupPanel.maximizePane', 'Maximize pane')
            }
            data-workspace-pane-maximize={maximized ? undefined : worktreeId}
            data-workspace-pane-restore={maximized ? worktreeId : undefined}
            onClick={(event) => {
              event.stopPropagation()
              if (maximized) {
                useAppStore.getState().restoreWorkspaceSplitPanes()
              } else {
                useAppStore.getState().maximizeWorkspacePane(worktreeId)
              }
            }}
            className={buttonClassName}
          >
            {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {maximized
            ? translate(
                'auto.components.tab.group.TabGroupPanel.restoreSplitTip',
                'Back to the split grid'
              )
            : translate(
                'auto.components.tab.group.TabGroupPanel.maximizePaneTip',
                'Show this project full width — the split stays underneath'
              )}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={translate(
              'auto.components.tab.group.TabGroupPanel.removeFromSplit',
              'Remove from split'
            )}
            data-workspace-pane-close={worktreeId}
            onClick={(event) => {
              event.stopPropagation()
              useAppStore.getState().closeWorkspacePane(worktreeId)
            }}
            className={buttonClassName}
          >
            <X className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.tab.group.TabGroupPanel.removeFromSplitTip',
            'Remove from split — keeps the project and its terminals'
          )}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
