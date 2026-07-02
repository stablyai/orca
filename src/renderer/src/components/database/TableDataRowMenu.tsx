import React from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

export type TableDataRowAction = {
  label: string
  onSelect: () => void
  destructive?: boolean
}

// Right-click menu for a data grid row (delete/restore/discard). Kept generic so
// existing and new rows share the same wrapper.
export function TableDataRowMenu({
  children,
  actions
}: {
  children: React.ReactNode
  actions: TableDataRowAction[]
}): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {actions.map((action) => (
          <ContextMenuItem
            key={action.label}
            variant={action.destructive ? 'destructive' : 'default'}
            onSelect={action.onSelect}
          >
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
