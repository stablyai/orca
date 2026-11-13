import React from 'react'
import { Play } from 'lucide-react'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'

export function MenuRunItem({
  disabled,
  disabledReason,
  label,
  onSelect
}: {
  disabled: boolean
  disabledReason?: string
  label: string
  onSelect: () => void
}): React.JSX.Element {
  const item = (
    <ContextMenuItem
      disabled={disabled}
      onSelect={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        onSelect()
      }}
    >
      <Play className="size-3.5" />
      <span className="min-w-0 truncate">{label}</span>
    </ContextMenuItem>
  )
  // Disabled items ignore pointer events; put explanatory titles on a wrapper.
  return disabledReason ? <div title={disabledReason}>{item}</div> : item
}

export function MenuItem({
  disabled,
  icon,
  label,
  onSelect,
  variant
}: {
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
  variant?: 'destructive'
}): React.JSX.Element {
  return (
    <ContextMenuItem disabled={disabled} variant={variant} onSelect={onSelect}>
      {icon}
      {label}
    </ContextMenuItem>
  )
}

export function MenuSeparator(): React.JSX.Element {
  return <ContextMenuSeparator />
}
