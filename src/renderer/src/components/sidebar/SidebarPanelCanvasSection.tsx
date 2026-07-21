import React from 'react'
import { ChevronRight, LayoutGrid } from 'lucide-react'
import { useAppStore } from '@/store'
import { countCanvasLeaves } from '@/lib/panel-canvas'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { PanelLayoutButton } from './SidebarPanelRows'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

/** The live canvas row under "Panel Canvas". Exists whether or not the canvas
 *  was ever saved: a scratch canvas built from split actions is session state
 *  (L1 arrangement + L2 tile PTYs) that had no sidebar affordance before, so
 *  switching views stranded it. Clicking returns to it; the context menu can
 *  close it (killing its tiles). "Unsaved canvas" is stated plainly rather
 *  than implying a layout is backing it. */
export function LiveCanvasButton({
  leafCount,
  layoutTitle,
  active,
  onOpen,
  onClose
}: {
  leafCount: number
  layoutTitle: string | null
  active: boolean
  onOpen: () => void
  onClose: () => void
}): React.JSX.Element {
  const label =
    layoutTitle ??
    translate('auto.components.sidebar.SidebarPanelsNav.unsavedCanvas', 'Unsaved canvas')
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-4 text-left text-[13px] font-medium tracking-tight transition-colors',
            active
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <LayoutGrid
            className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
            strokeWidth={active ? 2.25 : 1.75}
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-worktree-sidebar-foreground/40">
            {leafCount}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={onClose}>
          {translate('auto.components.sidebar.SidebarPanelsNav.closeCanvas', 'Close canvas')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * The "Panel Canvas" branch of the sidebar: a collapsible parent holding the
 * live canvas row and a nested "Saved Layouts" subtree.
 *
 * Why a parent branch: `panelCanvasRoot` is session state that survives a view
 * switch, but before this the sidebar only listed *saved* layouts. A canvas
 * built from split actions and never saved therefore became unreachable the
 * moment you clicked another view — its tiles kept running with no way back.
 * The live canvas is now always listed, saved or not, and saved layouts sit
 * one level below it so the two are never confused (L1 arrangement vs L0
 * definition — see shared/panel-lifespan.ts).
 */
export const SidebarPanelCanvasSection = React.memo(function SidebarPanelCanvasSection() {
  const activeView = useAppStore((s) => s.activeView)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const panelLayouts = useAppStore((s) => s.settings?.panelLayouts)
  const activePanelLayoutId = useAppStore((s) => s.activePanelLayoutId)
  const openPanelLayoutInCanvas = useAppStore((s) => s.openPanelLayoutInCanvas)
  const setActivePanelLayoutId = useAppStore((s) => s.setActivePanelLayoutId)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const closePanelCanvas = useAppStore((s) => s.closePanelCanvas)
  const canvasCollapsed = useAppStore((s) => s.settings?.panelCanvasCollapsed === true)
  const layoutsCollapsed = useAppStore((s) => s.settings?.panelLayoutsCollapsed === true)
  // Why: derive the count in the selector — returning the root node itself and
  // counting in render would re-run on every unrelated store update.
  const panelCanvasLeafCount = useAppStore((s) =>
    s.panelCanvasRoot === null ? 0 : countCanvasLeaves(s.panelCanvasRoot)
  )

  const deletePanelLayout = React.useCallback(
    (layoutId: string) => {
      void updateSettings({
        panelLayouts: (panelLayouts ?? []).filter((layout) => layout.id !== layoutId)
      })
      // Why: a canvas opened from the deleted layout must not keep offering
      // "Save" against an id that no longer exists.
      if (useAppStore.getState().activePanelLayoutId === layoutId) {
        setActivePanelLayoutId(null)
      }
    },
    [panelLayouts, updateSettings, setActivePanelLayoutId]
  )

  const layouts = panelLayouts ?? []
  const hasLiveCanvas = panelCanvasLeafCount > 0
  const hasLayouts = layouts.length > 0
  const openLiveCanvas = React.useCallback(() => setActiveView('panel-canvas'), [setActiveView])

  if (!hasLiveCanvas && !hasLayouts) {
    return null
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void updateSettings({ panelCanvasCollapsed: !canvasCollapsed })}
        aria-expanded={!canvasCollapsed}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
          canvasCollapsed && activeView === 'panel-canvas'
            ? 'text-worktree-sidebar-accent-foreground'
            : 'text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80'
        )}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', !canvasCollapsed && 'rotate-90')}
          strokeWidth={2}
        />
        <span className="min-w-0 flex-1 truncate">
          {translate('auto.components.sidebar.SidebarPanelsNav.panelCanvas', 'Panel Canvas')}
        </span>
      </button>
      {canvasCollapsed ? null : (
        <>
          {hasLiveCanvas ? (
            <LiveCanvasButton
              leafCount={panelCanvasLeafCount}
              layoutTitle={
                layouts.find((layout) => layout.id === activePanelLayoutId)?.title ?? null
              }
              active={activeView === 'panel-canvas'}
              onOpen={openLiveCanvas}
              onClose={closePanelCanvas}
            />
          ) : null}
          {hasLayouts ? (
            <>
              <button
                type="button"
                onClick={() => void updateSettings({ panelLayoutsCollapsed: !layoutsCollapsed })}
                aria-expanded={!layoutsCollapsed}
                className={cn(
                  'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 pl-4 text-left text-[10px] font-semibold tracking-wide uppercase transition-colors',
                  layoutsCollapsed &&
                    activeView === 'panel-canvas' &&
                    layouts.some((layout) => activePanelLayoutId === layout.id)
                    ? 'text-worktree-sidebar-accent-foreground'
                    : 'text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80'
                )}
              >
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    !layoutsCollapsed && 'rotate-90'
                  )}
                  strokeWidth={2}
                />
                <span className="min-w-0 flex-1 truncate">
                  {translate(
                    'auto.components.sidebar.SidebarPanelsNav.savedLayouts',
                    'Saved Layouts'
                  )}
                </span>
              </button>
              {layoutsCollapsed
                ? null
                : layouts.map((layout) => (
                    <div key={layout.id} className="pl-3">
                      <PanelLayoutButton
                        layout={layout}
                        active={activeView === 'panel-canvas' && activePanelLayoutId === layout.id}
                        onOpen={openPanelLayoutInCanvas}
                        onDelete={deletePanelLayout}
                      />
                    </div>
                  ))}
            </>
          ) : null}
        </>
      )}
    </>
  )
})

export default SidebarPanelCanvasSection
