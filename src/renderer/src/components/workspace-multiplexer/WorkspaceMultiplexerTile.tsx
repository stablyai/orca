import { useCallback, useEffect, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { Maximize2, Minimize2, PanelBottomOpen, PanelRightOpen, Plus, X } from 'lucide-react'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { translate } from '@/i18n/i18n'
import type {
  WorkspaceMultiplexerPane,
  WorkspaceMultiplexerSlot
} from '../../../../shared/workspace-multiplexer-types'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from '../tab-bar/drop-indicator'
import { useTabStripPointerActivation } from '../tab-bar/tab-strip-pointer-activation'
import TabGroupPanel from '../tab-group/TabGroupPanel'
import type { HoveredTabInsertion } from '../tab-group/useTabDragSplit'
import type {
  WorkspaceMultiplexerHoveredDropTarget,
  WorkspaceMultiplexerPaneDropData,
  WorkspaceMultiplexerSlotDragData
} from './WorkspaceMultiplexerDragScope'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'

const TILE_RESIZE_FIT_DELAYS_MS = [100, 450] as const

export type WorkspaceMultiplexerTabItem = {
  slot: WorkspaceMultiplexerSlot
  workspace: WorkspaceMultiplexerCatalogItem | null
}

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

function WorkspaceMultiplexerTab({
  paneId,
  item,
  active,
  hasTabsToRight,
  dropIndicator,
  onActivate,
  onRemove,
  onMove
}: {
  paneId: string
  item: WorkspaceMultiplexerTabItem
  active: boolean
  hasTabsToRight: boolean
  dropIndicator: DropIndicator
  onActivate: () => void
  onRemove: () => void
  onMove: (offset: -1 | 1) => void
}): React.JSX.Element {
  const { slot, workspace } = item
  const projectName =
    workspace?.projectName ??
    translate(
      'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.unknownProject',
      'Unknown project'
    )
  const workspaceName = workspace?.workspaceName ?? slot.worktreeId
  const { attributes, listeners, setNodeRef } = useSortable({
    id: `workspace-multiplexer-slot:${slot.id}`,
    data: {
      kind: 'workspace-multiplexer-slot',
      slotId: slot.id,
      paneId,
      projectName,
      workspaceName,
      projectBadgeColor: workspace?.projectBadgeColor ?? null
    } satisfies WorkspaceMultiplexerSlotDragData
  })
  const { onPointerDown } = useTabStripPointerActivation({ onActivate, disabled: false })
  const removeLabel = translate(
    'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.removeNamed',
    'Remove {{value0}} from Workspace Multiplexer',
    { value0: workspaceName }
  )

  return (
    <div
      ref={setNodeRef}
      data-workspace-multiplexer-drag-handle=""
      data-workspace-multiplexer-tab-id={slot.id}
      data-active={active ? 'true' : 'false'}
      {...attributes}
      {...listeners}
      aria-label={`${projectName} — ${workspaceName}`}
      className={`group relative flex h-full min-w-0 max-w-64 cursor-pointer select-none items-center gap-1.5 px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: false })} ${getDropIndicatorClasses(dropIndicator)} ${getTabRootStateClasses(active)}`}
      onPointerDown={(event) =>
        onPointerDown(
          event,
          listeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
        )
      }
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          onMove(-1)
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          onMove(1)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onActivate()
        }
      }}
    >
      {active ? <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden /> : null}
      <RepoBadgeMark color={workspace?.projectBadgeColor} className="size-2 rounded-[2px]" />
      <span className="truncate font-semibold text-foreground">{projectName}</span>
      <span className="truncate text-muted-foreground">{workspaceName}</span>
      <button
        type="button"
        className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={removeLabel}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        <X className="size-3" />
      </button>
    </div>
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
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <div
        className="flex h-8 shrink-0 items-center border-b border-border bg-muted/20 pr-2"
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button')) {
            onToggleExpanded()
          }
        }}
      >
        <SortableContext items={tabs.map((tab) => `workspace-multiplexer-slot:${tab.slot.id}`)}>
          <div className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden border-r border-border/70">
            {tabs.map((tab, index) => (
              <WorkspaceMultiplexerTab
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
      </div>
      {slot.groupId && groupAvailable && workspace ? (
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
        />
      ) : (
        <div ref={setPortalTarget} className="relative flex-1 min-h-0 bg-editor-surface">
          {emptyState}
        </div>
      )}
    </section>
  )
}
