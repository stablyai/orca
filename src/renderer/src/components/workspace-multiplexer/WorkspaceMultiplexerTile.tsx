import { useCallback, useEffect, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import {
  ChevronRight,
  Maximize2,
  Minimize2,
  PanelBottomOpen,
  PanelRightOpen,
  Plus
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { translate } from '@/i18n/i18n'
import type {
  WorkspaceMultiplexerPane,
  WorkspaceMultiplexerSlot
} from '../../../../shared/workspace-multiplexer-types'
import TabGroupPanel from '../tab-group/TabGroupPanel'
import type { HoveredTabInsertion } from '../tab-group/useTabDragSplit'
import type {
  WorkspaceMultiplexerHoveredDropTarget,
  WorkspaceMultiplexerPaneDropData
} from './WorkspaceMultiplexerDragScope'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'
import {
  WorkspaceMultiplexerWorkspaceTab,
  type WorkspaceMultiplexerTabItem
} from './WorkspaceMultiplexerWorkspaceTab'

const TILE_RESIZE_FIT_DELAYS_MS = [100, 450] as const

function TileAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation()
            onClick()
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorkspaceMultiplexerTile({
  pane,
  tabs,
  slot,
  workspace,
  groupAvailable,
  isFocused,
  isExpanded,
  isWorkspaceDropTarget,
  hoveredWorkspaceDropTarget,
  isTabDragActive,
  hoveredTabInsertion,
  onFocus,
  onSelectWorkspace,
  onRemoveWorkspace,
  onSelectTerminal,
  onPortalTarget,
  onSplit,
  onToggleExpanded,
  onNewTerminal,
  onWorkspaceMove
}: {
  pane: WorkspaceMultiplexerPane
  tabs: WorkspaceMultiplexerTabItem[]
  slot: WorkspaceMultiplexerSlot
  workspace: WorkspaceMultiplexerCatalogItem | null
  groupAvailable: boolean
  isFocused: boolean
  isExpanded: boolean
  isWorkspaceDropTarget: boolean
  hoveredWorkspaceDropTarget: WorkspaceMultiplexerHoveredDropTarget | null
  isTabDragActive: boolean
  hoveredTabInsertion: HoveredTabInsertion | null
  onFocus: () => void
  onSelectWorkspace: (slotId: string) => void
  onRemoveWorkspace: (slotId: string) => void
  onSelectTerminal: (terminalTabId: string) => void
  onPortalTarget: (slotId: string, element: HTMLDivElement | null) => void
  onSplit: (direction: 'right' | 'down') => void
  onToggleExpanded: () => void
  onNewTerminal: () => void
  onWorkspaceMove: (slotId: string, offset: -1 | 1) => void
}): React.JSX.Element {
  const unavailable = workspace === null
  const centerDropTarget =
    hoveredWorkspaceDropTarget?.paneId === pane.id && hoveredWorkspaceDropTarget.zone === 'center'
  const { setNodeRef: setPaneDropRef } = useDroppable({
    id: `workspace-multiplexer-pane:${pane.id}`,
    data: {
      kind: 'workspace-multiplexer-pane',
      paneId: pane.id
    } satisfies WorkspaceMultiplexerPaneDropData
  })
  const setPortalTarget = useCallback(
    (element: HTMLDivElement | null) => onPortalTarget(slot.id, element),
    [onPortalTarget, slot.id]
  )
  const sectionRef = useRef<HTMLElement | null>(null)
  // Portaled terminals bubble React events to their owner, not this tile.
  useEffect(() => {
    const section = sectionRef.current
    const focus = (): void => {
      if (!isFocused) {
        onFocus()
      }
    }
    section?.addEventListener('pointerdown', focus, true)
    section?.addEventListener('focusin', focus)
    return () => {
      section?.removeEventListener('pointerdown', focus, true)
      section?.removeEventListener('focusin', focus)
    }
  }, [isFocused, onFocus])
  const setSectionRef = useCallback(
    (element: HTMLElement | null) => {
      sectionRef.current = element
      setPaneDropRef(element)
    },
    [setPaneDropRef]
  )
  // Why: a portaled pane keeps drawing at its old size when its tile is resized by a split, merge, drag, or maximize; only the global fit event refits it.
  // Why two passes: the first fit can land before the flex layout settles, leaving a stale WebGL frame until the next resize.
  useEffect(() => {
    const section = sectionRef.current
    if (!section) {
      return
    }
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const observer = new ResizeObserver(() => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
      for (const delay of TILE_RESIZE_FIT_DELAYS_MS) {
        const timer = setTimeout(() => {
          timers.delete(timer)
          window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
        }, delay)
        timers.add(timer)
      }
    })
    observer.observe(section)
    return () => {
      observer.disconnect()
      for (const timer of timers) {
        clearTimeout(timer)
      }
    }
  }, [])
  const emptyState = (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-editor-surface px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {unavailable
            ? translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.unavailable',
                'Workspace unavailable'
              )
            : translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.noTerminal',
                'No terminal in this split'
              )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {unavailable
            ? translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.unavailableHint',
                'The workspace may be disconnected or no longer in the catalog.'
              )
            : translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.noTerminalHint',
                'Open a terminal here without leaving Workspace Multiplexer.'
              )}
        </p>
      </div>
      {!unavailable ? (
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={onNewTerminal}>
          <Plus className="size-3.5" />
          {translate(
            'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.newTerminal',
            'New terminal'
          )}
        </Button>
      ) : null}
    </div>
  )
  const hasTabGroup = Boolean(slot.groupId && groupAvailable && workspace)
  const workspaceTabStrip = (
    <>
      <SortableContext items={tabs.map((tab) => `workspace-multiplexer-slot:${tab.slot.id}`)}>
        <div
          className={`flex h-full min-w-0 items-stretch overflow-x-auto overflow-y-hidden ${
            hasTabGroup ? 'max-w-[50%] flex-[0_1_auto]' : 'flex-1 border-r border-border/70'
          }`}
          data-workspace-multiplexer-tab-strip=""
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onDoubleClick={(event) => {
            if (!(event.target as HTMLElement).closest('button')) {
              onToggleExpanded()
            }
          }}
        >
          {tabs.map((tab, index) => (
            <WorkspaceMultiplexerWorkspaceTab
              key={tab.slot.id}
              paneId={pane.id}
              item={tab}
              active={tab.slot.id === slot.id}
              hasTabsToRight={index < tabs.length - 1}
              dropIndicator={
                hoveredWorkspaceDropTarget?.targetSlotId === tab.slot.id
                  ? (hoveredWorkspaceDropTarget.insertSide ?? null)
                  : null
              }
              onActivate={() => onSelectWorkspace(tab.slot.id)}
              onRemove={() => onRemoveWorkspace(tab.slot.id)}
              onMove={(offset) => onWorkspaceMove(tab.slot.id, offset)}
            />
          ))}
        </div>
      </SortableContext>
      {hasTabGroup ? (
        <span
          className="flex h-full w-5 shrink-0 items-center justify-center text-muted-foreground/70"
          data-workspace-multiplexer-hierarchy-marker=""
          aria-hidden
        >
          <ChevronRight className="size-3" />
        </span>
      ) : null}
    </>
  )
  const tileActions = (
    <>
      {slot.groupId && !unavailable ? (
        <>
          <TileAction
            label={translate(
              'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.splitRight',
              'Split workspace right'
            )}
            onClick={() => onSplit('right')}
          >
            <PanelRightOpen className="size-3.5" />
          </TileAction>
          <TileAction
            label={translate(
              'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.splitDown',
              'Split workspace down'
            )}
            onClick={() => onSplit('down')}
          >
            <PanelBottomOpen className="size-3.5" />
          </TileAction>
        </>
      ) : null}
      <TileAction
        label={
          isExpanded
            ? translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.restore',
                'Restore Workspace Multiplexer layout'
              )
            : translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.maximize',
                'Maximize workspace'
              )
        }
        onClick={onToggleExpanded}
      >
        {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </TileAction>
    </>
  )

  return (
    <section
      ref={setSectionRef}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-card transition-[border-color,box-shadow] duration-150 ${
        isWorkspaceDropTarget || (centerDropTarget && !hoveredWorkspaceDropTarget.targetSlotId)
          ? 'border-ring ring-2 ring-ring/60'
          : isFocused
            ? 'border-ring ring-1 ring-ring/50'
            : 'border-border'
      }`}
      data-workspace-multiplexer-pane-id={pane.id}
      data-workspace-multiplexer-slot-id={slot.id}
      data-workspace-multiplexer-drop-target={centerDropTarget ? '' : undefined}
    >
      {!hasTabGroup ? (
        <div className="flex h-10 shrink-0 items-center border-b border-border bg-muted/20 pr-2">
          {workspaceTabStrip}
          {tileActions}
        </div>
      ) : null}
      {hasTabGroup && slot.groupId ? (
        <TabGroupPanel
          groupId={slot.groupId}
          worktreeId={slot.worktreeId}
          isVisible
          isFocused={isFocused}
          hasSplitGroups={false}
          touchesRightEdge
          touchesLeftEdge
          reserveClosedExplorerToggleSpace={false}
          reserveCollapsedSidebarHeaderSpace={false}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={hoveredTabInsertion}
          terminalOnly
          activeTerminalTabId={slot.activeTerminalTabId}
          onTerminalActivate={onSelectTerminal}
          onBodyElement={setPortalTarget}
          terminalEmptyState={emptyState}
          tabBarSlots={{ leading: workspaceTabStrip, trailing: tileActions }}
        />
      ) : (
        <div ref={setPortalTarget} className="relative flex-1 min-h-0 bg-editor-surface">
          {emptyState}
        </div>
      )}
    </section>
  )
}
