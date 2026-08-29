import React from 'react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type SkillRowAction = {
  key: string
  label: string
  icon: React.JSX.Element
  disabled?: boolean
  /** Why an item-level reason: the existing row badge is shown only in selection
   *  mode, and a disabled `Delete…` has to explain itself outside it too. */
  disabledReason?: string
  destructive?: boolean
  onSelect: () => void
}

/**
 * Radix disables pointer events on a disabled item, so the tooltip has to fire
 * on a wrapper that keeps them.
 */
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
