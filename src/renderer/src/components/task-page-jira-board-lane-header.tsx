import React from 'react'
import { MoreHorizontal } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type TaskPageJiraBoardLaneHeaderProps = {
  label: string
  issueCount: number
  canMoveLeft: boolean
  canMoveRight: boolean
  canReset: boolean
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onReset: () => void
}

// The menu is the keyboard path for the same reorder the header drag does.
export function TaskPageJiraBoardLaneHeader({
  label,
  issueCount,
  canMoveLeft,
  canMoveRight,
  canReset,
  onDragStart,
  onDragEnd,
  onMoveLeft,
  onMoveRight,
  onReset
}: TaskPageJiraBoardLaneHeaderProps): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="group/lane flex h-9 cursor-grab items-center justify-between gap-2 border-b border-border/50 px-3 active:cursor-grabbing"
    >
      <Badge variant="secondary">
        <span className="truncate">{label || '—'}</span>
      </Badge>
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-2xs text-muted-foreground">{issueCount}</span>
        <div className="flex md:opacity-0 md:transition-opacity md:group-hover/lane:opacity-100 md:group-focus-within/lane:opacity-100 md:has-[[data-state=open]]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate('jira.board.laneActions', 'Lane actions for {{column}}', {
                  column: label
                })}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!canMoveLeft} onClick={onMoveLeft}>
                {translate('jira.board.moveLaneLeft', 'Move lane left')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canMoveRight} onClick={onMoveRight}>
                {translate('jira.board.moveLaneRight', 'Move lane right')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canReset} onClick={onReset}>
                {translate('jira.board.resetLaneOrder', 'Reset lane order')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
