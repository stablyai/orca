import React from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import type { PrimaryAction } from './source-control-primary-action'

// Show only useful tooltip context: blockers, counts, shortcuts, or the Create intent's hidden stage/commit/push steps.
export function shouldShowPrimaryTooltip(
  primaryAction: Pick<PrimaryAction, 'kind' | 'disabled'>
): boolean {
  if (primaryAction.disabled) {
    return true
  }
  return (
    primaryAction.kind === 'commit' ||
    primaryAction.kind === 'create_pr_intent' ||
    primaryAction.kind === 'push' ||
    primaryAction.kind === 'pull' ||
    primaryAction.kind === 'sync' ||
    primaryAction.kind === 'publish'
  )
}

// Share tooltip policy between the commit split button and header Create PR action.
export function PrimaryActionTooltip({
  action,
  side,
  children
}: {
  action: PrimaryAction
  side: 'top' | 'bottom'
  children: React.JSX.Element
}): React.JSX.Element {
  if (!shouldShowPrimaryTooltip(action)) {
    return children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6} className="max-w-72">
        {action.kind === 'commit' ? (
          <span className="flex items-center gap-2">
            <span>{action.title}</span>
            <ShortcutKeyCombo keys={[getScreenSubmitModifierLabel(), 'Enter']} />
          </span>
        ) : (
          <span>{action.title}</span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
