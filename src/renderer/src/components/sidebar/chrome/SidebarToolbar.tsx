import React from 'react'
import { Kanban } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ScrollToCurrentWorkspaceToolbarButton } from '../worktree-list/navigation/ScrollToCurrentWorkspaceToolbarButton'
import { SidebarSettingsHelpMenu } from './SidebarSettingsHelpMenu'
import { selectAppRailVisible } from '@/components/app-rail/app-rail-layout'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { WorkspaceBoardMovedHint } from './WorkspaceBoardMovedHint'
import { useWorkspaceBoardMovedHint } from './use-workspace-board-moved-hint'

type SidebarToolbarProps = {
  workspaceBoardOpen: boolean
  workspaceBoardDragPreviewOpen?: boolean
  onWorkspaceBoardToggle: () => void
}

const SidebarToolbar = React.memo(function SidebarToolbar({
  workspaceBoardOpen,
  workspaceBoardDragPreviewOpen = false,
  onWorkspaceBoardToggle
}: SidebarToolbarProps) {
  const t = useTranslate()
  // Subscribe across this memo boundary so asynchronously applied locale changes relabel the toolbar and its children.
  useTranslation()
  // The rail owns Settings and Help when it is on.
  const appRailVisible = useAppStore(selectAppRailVisible)
  const movedHint = useWorkspaceBoardMovedHint()
  const movedHintId = React.useId()
  const boardButtonRef = React.useRef<HTMLButtonElement>(null)
  // Never forced open. While the moved hint shows or fades, the label's content is unmounted outright (an
  // exiting label would keep its Escape layer) and any open intent is dropped, so two bubbles never stack.
  const [boardLabelOpen, setBoardLabelOpen] = React.useState(false)
  const boardLabelSuppressed = movedHint.labelSuppressed
  // Each suppression bumps this; a hover or focus begun before the latest one can't open the label later
  // (Radix may still hold a delayed open armed before the hint appeared). Only a gesture that starts after
  // suppression ends records the new value; one made during it (e.g. Tab in the fade) validates nothing.
  const labelSuppressionCountRef = React.useRef(0)
  const labelGestureCountRef = React.useRef(0)
  React.useEffect(() => {
    if (boardLabelSuppressed) {
      labelSuppressionCountRef.current += 1
      setBoardLabelOpen(false)
    }
  }, [boardLabelSuppressed])
  const recordLabelGesture = (): void => {
    if (!boardLabelSuppressed) {
      labelGestureCountRef.current = labelSuppressionCountRef.current
    }
  }
  const movedHintText = t(
    'auto.components.sidebar.SidebarToolbar.87d0064026',
    'Workspace board moved to the bottom bar'
  )

  const handleWorkspaceBoardClick = (): void => {
    movedHint.hide()
    onWorkspaceBoardToggle()
  }

  return (
    <div className="mt-auto shrink-0">
      <div className="flex items-center justify-between border-t border-worktree-sidebar-border px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {appRailVisible ? null : <SidebarSettingsHelpMenu />}
        </div>
        <div className="flex items-center gap-1">
          <ScrollToCurrentWorkspaceToolbarButton />
          <Tooltip
            open={boardLabelOpen && !boardLabelSuppressed}
            onOpenChange={(open) =>
              setBoardLabelOpen(
                open &&
                  !boardLabelSuppressed &&
                  labelGestureCountRef.current === labelSuppressionCountRef.current
              )
            }
          >
            <TooltipTrigger
              asChild
              // A hover or focus that starts while the hint is up must not open the label once it fades;
              // preventing these stops Radix from arming its delayed open. A fresh gesture afterwards works.
              onPointerEnter={recordLabelGesture}
              onPointerMove={(event) => {
                if (boardLabelSuppressed) {
                  event.preventDefault()
                }
              }}
              onFocus={(event) => {
                recordLabelGesture()
                if (boardLabelSuppressed) {
                  event.preventDefault()
                }
              }}
            >
              <Button
                ref={boardButtonRef}
                variant={
                  workspaceBoardOpen || workspaceBoardDragPreviewOpen ? 'secondary' : 'ghost'
                }
                size="icon-xs"
                type="button"
                aria-label={t(
                  'auto.components.sidebar.SidebarToolbar.49f62c5665',
                  'Workspace board'
                )}
                aria-pressed={workspaceBoardOpen}
                data-workspace-board-trigger=""
                data-workspace-board-preview={workspaceBoardDragPreviewOpen ? 'true' : undefined}
                onClick={handleWorkspaceBoardClick}
                className="text-muted-foreground"
                // Spread only while showing: an undefined value would override Radix's own describedby.
                {...(movedHint.showing ? { 'aria-describedby': movedHintId } : {})}
              >
                <Kanban className="size-3.5" />
              </Button>
            </TooltipTrigger>
            {boardLabelSuppressed ? null : (
              <TooltipContent side="top" sideOffset={4}>
                {workspaceBoardOpen
                  ? t('auto.components.sidebar.SidebarToolbar.a30e34eb5c', 'Close workspace board')
                  : t('auto.components.sidebar.SidebarToolbar.49f62c5665', 'Workspace board')}
              </TooltipContent>
            )}
          </Tooltip>
          {/* Unmounted outright (no fade) while a rail page hides the button it points at. */}
          {movedHint.listVisible ? (
            <WorkspaceBoardMovedHint
              id={movedHintId}
              open={movedHint.showing}
              anchorRef={boardButtonRef}
            >
              {movedHintText}
            </WorkspaceBoardMovedHint>
          ) : null}
        </div>
      </div>
    </div>
  )
})

export default SidebarToolbar
