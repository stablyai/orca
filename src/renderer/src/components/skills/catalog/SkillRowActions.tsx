import React from 'react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type SkillRowAction = {
  key: string
  label: string
  icon: React.JSX.Element
  disabled?: boolean
  /** Explain disabled actions outside selection mode too, where the row badge is absent. */
  disabledReason?: string
  destructive?: boolean
  onSelect: () => void
}

/** Wrap disabled items to retain pointer events for their explanatory tooltip. */
function withReason(action: SkillRowAction, item: React.JSX.Element): React.JSX.Element {
  if (!action.disabled || !action.disabledReason) {
    return item
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="pointer-events-auto block">{item}</span>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={4}>
        {action.disabledReason}
      </TooltipContent>
    </Tooltip>
  )
}

export function SkillRowDropdownActions({
  actions
}: {
  actions: readonly SkillRowAction[]
}): React.JSX.Element {
  return (
    <>
      {actions.map((action) => (
        <React.Fragment key={action.key}>
          {withReason(
            action,
            <DropdownMenuItem
              disabled={action.disabled}
              variant={action.destructive ? 'destructive' : 'default'}
              onSelect={action.onSelect}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          )}
        </React.Fragment>
      ))}
    </>
  )
}

export function SkillRowContextActions({
  actions
}: {
  actions: readonly SkillRowAction[]
}): React.JSX.Element {
  return (
    <>
      {actions.map((action) => (
        <React.Fragment key={action.key}>
          {withReason(
            action,
            <ContextMenuItem
              disabled={action.disabled}
              variant={action.destructive ? 'destructive' : 'default'}
              onSelect={action.onSelect}
            >
              {action.icon}
              {action.label}
            </ContextMenuItem>
          )}
        </React.Fragment>
      ))}
    </>
  )
}
