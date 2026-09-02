import type { PointerEvent } from 'react'
import { GripVertical, Pin, PinOff, Plus, SquareTerminal, X } from 'lucide-react'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { TabBarQuickCommandsButton } from '../tab-bar/TabBarQuickCommandsButton'
import type { CanvasTerminalItem } from './CanvasTerminalCard'

export function CanvasTerminalCardHeader({
  item,
  worktreeId,
  onHeaderPointerDown,
  onMovePointerDown,
  onCreateTerminal,
  onTogglePinned,
  onClose
}: {
  item: CanvasTerminalItem
  worktreeId: string
  onHeaderPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onMovePointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  onCreateTerminal?: (groupId: string) => void
  onTogglePinned?: (item: CanvasTerminalItem) => void
  onClose?: (terminalTabId: string) => void
}): React.JSX.Element {
  const pinLabel = item.pinned
    ? translate('auto.components.tab.group.CanvasTerminalCard.unpin', 'Remove from pinned view')
    : translate('auto.components.tab.group.CanvasTerminalCard.pin', 'Pin to Control Room')

  return (
    <div
      className="flex h-8 shrink-0 cursor-grab touch-none items-center border-b border-border bg-card active:cursor-grabbing"
      data-pane-canvas-card-header="true"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onPointerDown={onHeaderPointerDown}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={translate(
              'auto.components.tab.group.TabGroupCanvasLayout.movePane',
              'Move terminal'
            )}
            className="flex h-full w-7 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground active:cursor-grabbing"
            onPointerDown={onMovePointerDown}
          >
            <GripVertical className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.tab.group.TabGroupCanvasLayout.movePane', 'Move terminal')}
        </TooltipContent>
      </Tooltip>
      {item.agentState ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="mr-1 inline-flex shrink-0">
              <AgentStateDot state={item.agentState} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {agentStateLabel(item.agentState)}
          </TooltipContent>
        </Tooltip>
      ) : (
        <SquareTerminal className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
      )}
      {item.color ? (
        <span
          className="mr-1 size-2 shrink-0 rounded-full"
          style={{ backgroundColor: item.color }}
        />
      ) : null}
      <span className="min-w-0 truncate text-xs text-foreground">{item.label}</span>
      {item.ownerLabel ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          · {item.ownerLabel}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {item.agentCount && item.agentCount > 1 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {translate(
            'auto.components.tab.group.CanvasTerminalCard.agentCount',
            '{{value0}} agents',
            {
              value0: item.agentCount
            }
          )}
        </span>
      ) : null}
      {item.subagentCount ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {translate(
            'auto.components.tab.group.CanvasTerminalCard.subagentCount',
            '+{{value0}} subagents',
            { value0: item.subagentCount }
          )}
        </span>
      ) : null}
      <TabBarQuickCommandsButton worktreeId={worktreeId} groupId={item.groupId} />
      {onTogglePinned ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={pinLabel}
              className="flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              onClick={() => onTogglePinned(item)}
            >
              {item.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{pinLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {onCreateTerminal ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={translate(
                'auto.components.tab.group.TabGroupCanvasLayout.newTerminal',
                'New terminal'
              )}
              className="flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              onClick={() => onCreateTerminal(item.groupId)}
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {translate(
              'auto.components.tab.group.TabGroupCanvasLayout.newTerminal',
              'New terminal'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {onClose ? (
        <button
          type="button"
          aria-label={translate(
            'auto.components.tab.group.TabGroupCanvasLayout.closeTerminal',
            'Close terminal'
          )}
          className="flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          onClick={() => onClose(item.terminalTabId)}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
