import React from 'react'
import { Braces, Circle, MessageSquareText, Pencil, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type BreakpointGutterMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  point: { x: number; y: number }
  hasBreakpoint: boolean
  onAddBreakpoint: () => void
  onAddConditional: () => void
  onAddLogpoint: () => void
  onEdit: () => void
  onRemove: () => void
}

export function BreakpointGutterMenu({
  open,
  onOpenChange,
  point,
  hasBreakpoint,
  onAddBreakpoint,
  onAddConditional,
  onAddLogpoint,
  onEdit,
  onRemove
}: BreakpointGutterMenuProps): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: point.x, top: point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent sideOffset={0} align="start">
        {hasBreakpoint ? (
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              {translate('debug.breakpointGutter.editBreakpoint', 'Edit Breakpoint...')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRemove} variant="destructive">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {translate('debug.breakpointGutter.removeBreakpoint', 'Remove Breakpoint')}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={onAddBreakpoint}>
              <Circle className="w-3.5 h-3.5 mr-1.5" />
              {translate('debug.breakpointGutter.addBreakpoint', 'Add Breakpoint')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddConditional}>
              <Braces className="w-3.5 h-3.5 mr-1.5" />
              {translate(
                'debug.breakpointGutter.addConditionalBreakpoint',
                'Add Conditional Breakpoint...'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddLogpoint}>
              <MessageSquareText className="w-3.5 h-3.5 mr-1.5" />
              {translate('debug.breakpointGutter.addLogpoint', 'Add Logpoint...')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
