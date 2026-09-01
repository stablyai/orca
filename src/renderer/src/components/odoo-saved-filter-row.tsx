import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Check, GripVertical, Pin, Star, Trash2 } from 'lucide-react'

import type { OdooSavedTicketFilter } from '@/components/odoo-saved-ticket-filters'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/**
 * One saved filter in the menu: a drag handle for its sequence, the recall
 * button, then pin / star / delete. Dragging is confined to the handle so the
 * row's own buttons keep taking plain clicks.
 */
export function OdooSavedFilterRow({
  entry,
  active,
  onApply,
  onTogglePinned,
  onSetDefault,
  onDelete
}: {
  entry: OdooSavedTicketFilter
  active: boolean
  onApply: (entry: OdooSavedTicketFilter) => void
  onTogglePinned: (id: string) => void
  onSetDefault: (id: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: entry.id })

  return (
    <div
      ref={setNodeRef}
      // Horizontal drift is dropped: the list only reorders vertically, and
      // @dnd-kit/modifiers is not a dependency here.
      style={{
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition
      }}
      className={cn(
        'group relative flex items-center gap-1 bg-popover px-1 hover:bg-accent/60',
        isDragging && 'z-10 opacity-80 shadow-sm'
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
        aria-label={translate(
          'auto.components.odoo.saved.filter.row.6cba4187fd',
          'Reorder saved filter'
        )}
      >
        <GripVertical className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => onApply(entry)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-xs"
      >
        <Check
          className={cn(
            'size-3 shrink-0 text-muted-foreground',
            active ? 'opacity-70' : 'opacity-0'
          )}
        />
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-pressed={entry.pinned === true}
        className={cn(
          'size-6 shrink-0 transition-opacity',
          entry.pinned
            ? 'text-foreground opacity-100'
            : 'text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
        )}
        aria-label={translate(
          'auto.components.odoo.saved.filter.row.df9e217790',
          'Pin to the toolbar'
        )}
        onClick={() => onTogglePinned(entry.id)}
      >
        <Pin className={cn('size-3', entry.pinned && 'fill-current')} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-pressed={entry.isDefault === true}
        className={cn(
          'size-6 shrink-0 transition-opacity',
          entry.isDefault
            ? 'text-amber-500 opacity-100'
            : 'text-muted-foreground opacity-0 hover:text-amber-500 focus-visible:opacity-100 group-hover:opacity-100'
        )}
        aria-label={translate(
          'auto.components.odoo.saved.filter.row.eaec3d3a60',
          'Use as default filter'
        )}
        onClick={() => onSetDefault(entry.id)}
      >
        <Star className={cn('size-3', entry.isDefault && 'fill-current')} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={translate(
          'auto.components.odoo.saved.filter.row.2e129beeed',
          'Delete saved filter'
        )}
        onClick={() => onDelete(entry.id)}
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  )
}
