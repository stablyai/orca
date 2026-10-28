import { memo, Suspense, useCallback, useMemo } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, Maximize2, Minimize2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  focusWorkspaceViewPanel,
  removeWorkspaceViewPanelKeepingFocus
} from '@/lib/workspace-view-actions'
import {
  workspaceViewAnchorId,
  type WorkspaceViewPanel,
  type WorkspaceViewRect
} from '@/lib/workspace-view-layout'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import type { Tab } from '../../../../shared/tab-types'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { registerTabGroupBody } from '../tab-group/tab-group-body-geometry'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem
} from '../ui/dropdown-menu'
import { AgentStateDot } from '../AgentStateDot'
import { useTerminalTabActivity } from '../tab-bar/use-terminal-tab-activity'
import { terminalTabActivityToAgentDotState } from '../tab-bar/terminal-tab-activity-status'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

function TerminalStatus({ tab }: { tab: TerminalTab }): React.JSX.Element | null {
  const { activityStatus, programProgress } = useTerminalTabActivity(tab)
  const dot = terminalTabActivityToAgentDotState(activityStatus)
  return dot ? <AgentStateDot state={dot} progress={programProgress} /> : null
}

export const WorkspaceViewPanelSlot = memo(function WorkspaceViewPanelSlot({
  panel,
  tab,
  rect,
  focused,
  expanded
}: {
  panel: WorkspaceViewPanel
  tab: Tab | null
  rect: WorkspaceViewRect
  focused: boolean
  expanded: boolean
}): React.JSX.Element {
  useTranslation()
  const hostLabel = useAppStore((state) =>
    selectExecutionHostDisplayLabel(state, panel.executionHostId)
  )
  const generatedTitles = useAppStore((state) => state.settings?.tabAutoGenerateTitle === true)
  const terminal = useAppStore((state) =>
    tab?.contentType === 'terminal'
      ? state.tabsByWorktree[panel.workspaceId]?.find((terminal) => terminal.id === tab.entityId)
      : undefined
  )
  const anchorId = workspaceViewAnchorId(panel.id)
  const registerBody = useCallback(
    (node: HTMLDivElement | null) => (node ? registerTabGroupBody(anchorId, node) : undefined),
    [anchorId]
  )
  const bodyStyle: React.CSSProperties = useMemo(
    () => ({ anchorName: tabGroupBodyAnchorName(anchorId) }),
    [anchorId]
  )
  const title = tab ? resolveUnifiedTabLabel(tab, generatedTitles, tab.label) : panel.title
  const expandLabel = expanded
    ? translate('workspaceViews.restorePanels', 'Restore all panels')
    : translate('workspaceViews.expandPanel', 'Expand panel')
  const removeLabel = translate('workspaceViews.removePanel', 'Remove from view; keep session open')
  return (
    <section
      data-workspace-view-panel-id={panel.id}
      data-workspace-view-tab-id={tab?.id}
      data-current={focused ? 'true' : undefined}
      aria-label={`${panel.projectName} / ${panel.workspaceName} / ${title}`}
      className={cn(
        'pointer-events-auto absolute flex min-h-0 min-w-0 flex-col border border-border bg-background',
        focused && 'ring-1 ring-inset ring-ring'
      )}
      style={{
        left: `${rect.left}%`,
        top: `${rect.top}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`
      }}
      onPointerDownCapture={(event) => {
        if (
          !(event.target instanceof Element && event.target.closest('[data-workspace-view-action]'))
        ) {
          focusWorkspaceViewPanel(panel.id)
        }
      }}
      onFocusCapture={(event) => {
        if (
          !(event.target instanceof Element && event.target.closest('[data-workspace-view-action]'))
        ) {
          focusWorkspaceViewPanel(panel.id)
        }
      }}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-workspace-view-panel-header]') &&
          !event.target.closest('[data-workspace-view-action]')
        ) {
          focusWorkspaceViewPanel(panel.id, true)
        }
      }}
    >
      <div
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2"
        data-workspace-view-panel-header=""
      >
        <span className="min-w-0 truncate text-xs font-medium">{panel.projectName}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {panel.workspaceName}
        </span>
        {panel.executionHostId !== 'local' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="max-w-24 truncate text-xs text-muted-foreground">{hostLabel}</span>
            </TooltipTrigger>
            <TooltipContent>{hostLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center" data-workspace-view-action="">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${expandLabel}: ${title}`}
                onClick={() => {
                  focusWorkspaceViewPanel(panel.id)
                  useAppStore.getState().toggleWorkspaceViewPanelExpand(panel.id)
                }}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{expandLabel}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${removeLabel}: ${title}`}
                onClick={() => removeWorkspaceViewPanelKeepingFocus(panel.id)}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{removeLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div
        className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2"
        data-workspace-view-action=""
      >
        {terminal ? <TerminalStatus tab={terminal} /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="min-w-0"
              aria-label={translate('workspaceViews.panelActions', 'Panel actions: {{title}}', {
                title
              })}
            >
              <span className="truncate">{title}</span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() =>
                  useAppStore.getState().setWorkspaceViewPicker({ replacePanelId: panel.id })
                }
              >
                {translate('workspaceViews.changePanel', 'Choose another panel…')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => useAppStore.getState().moveWorkspaceViewPanel(panel.id, -1)}
              >
                <ArrowLeft />
                {translate('workspaceViews.moveEarlier', 'Move earlier')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => useAppStore.getState().moveWorkspaceViewPanel(panel.id, 1)}
              >
                <ArrowRight />
                {translate('workspaceViews.moveLater', 'Move later')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={registerBody}
        style={bodyStyle}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-workspace-view-body=""
      >
        {!tab ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground">
            <span>
              {translate(
                'workspaceViews.unavailable',
                'This panel is unavailable. Its workspace or host may be offline, or the panel may have closed.'
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                useAppStore.getState().setWorkspaceViewPicker({ replacePanelId: panel.id })
              }
            >
              {translate('workspaceViews.choosePanel', 'Choose panel')}
            </Button>
          </div>
        ) : ['editor', 'diff', 'conflict-review', 'check-details'].includes(tab.contentType) ? (
          <Suspense
            fallback={
              <div className="p-4 text-sm text-muted-foreground">
                {translate('workspaceViews.loadingPanel', 'Loading panel…')}
              </div>
            }
          >
            <EditorPanel
              activeFileId={tab.entityId}
              activeViewStateId={tab.id}
              isVisible
              isCmdSaveOwner={focused}
            />
          </Suspense>
        ) : null}
      </div>
    </section>
  )
})
