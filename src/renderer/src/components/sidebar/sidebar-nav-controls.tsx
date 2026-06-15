import React from 'react'
import { EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'

export function HideSidebarMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onHide}>
        <EyeOff className="size-3.5" />
        {translate('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

export function TaskProviderShortcut({
  canBrowseTasks,
  label,
  onOpen,
  children
}: {
  canBrowseTasks: boolean
  label: string
  onOpen: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role={canBrowseTasks ? 'button' : undefined}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation()
        if (!canBrowseTasks) {
          return
        }
        onOpen()
      }}
      className={cn(
        'rounded p-0.5 text-muted-foreground/70',
        canBrowseTasks ? 'transition-colors hover:text-foreground' : 'cursor-default'
      )}
      aria-label={canBrowseTasks ? label : undefined}
      aria-hidden={canBrowseTasks ? undefined : true}
    >
      {children}
    </span>
  )
}
