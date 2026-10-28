import { LayoutGrid, Columns2, Plus, Maximize, Minimize, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { selectShownWorkspaceView } from '@/lib/workspace-view-catalog'
import { WORKSPACE_VIEW_MAX_PANELS } from '@/lib/workspace-view-layout'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { WorkspaceViewsMenu } from './WorkspaceViewsMenu'

export function WorkspaceViewToolbar(): React.JSX.Element | null {
  useTranslation()
  const view = useAppStore(selectShownWorkspaceView)
  const fill = useAppStore((state) => state.workspaceViewFillWindow)
  const fullScreen = useAppStore((state) => state.isFullScreen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  if (!view) {
    return null
  }
  const fillLabel = fill
    ? translate('workspaceViews.showNavigation', 'Show navigation')
    : translate('workspaceViews.fillWindow', 'Fill window')
  const exitLabel = translate('workspaceViews.exitView', 'Return to workspace')
  return (
    <div className="titlebar shrink-0 gap-2 px-2" data-workspace-view-toolbar="">
      {!sidebarOpen || fill ? (
        <div
          className="shrink-0 [-webkit-app-region:no-drag]"
          style={{
            width: fill
              ? fullScreen
                ? 0
                : 'calc(var(--mac-traffic-lights-width, 0px) / var(--ui-zoom-factor, 1))'
              : 'var(--collapsed-sidebar-header-width)'
          }}
        />
      ) : null}
      <div className="min-w-0 [-webkit-app-region:no-drag]">
        <WorkspaceViewsMenu />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          type="single"
          size="sm"
          value={view.preset}
          aria-label={translate('workspaceViews.arrangement', 'Panel arrangement')}
          onValueChange={(value) => {
            if (value === 'grid' || value === 'primary') {
              useAppStore.getState().setWorkspaceViewPreset(value)
            }
          }}
        >
          <ToggleGroupItem value="grid" aria-label={translate('workspaceViews.grid', 'Equal grid')}>
            <LayoutGrid />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="primary"
            aria-label={translate('workspaceViews.primary', 'Primary and stack')}
          >
            <Columns2 />
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          size="sm"
          variant="outline"
          disabled={view.panels.length >= WORKSPACE_VIEW_MAX_PANELS}
          onClick={() => useAppStore.getState().setWorkspaceViewPicker({})}
        >
          <Plus />
          {translate('workspaceViews.addPanel', 'Add panel')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={fillLabel}
              aria-pressed={fill}
              onClick={() => useAppStore.getState().toggleWorkspaceViewFillWindow()}
            >
              {fill ? <Minimize /> : <Maximize />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{fillLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={exitLabel}
              onClick={() => useAppStore.getState().selectWorkspaceView(null)}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{exitLabel}</TooltipContent>
        </Tooltip>
      </div>
      {!rightSidebarOpen || fill ? (
        <div
          className="shrink-0 [-webkit-app-region:no-drag]"
          style={{
            width: fill
              ? 'var(--window-controls-width, 0px)'
              : 'calc(40px + var(--window-controls-width, 0px))'
          }}
        />
      ) : null}
    </div>
  )
}
