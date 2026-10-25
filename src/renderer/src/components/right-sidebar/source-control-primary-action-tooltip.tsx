import React from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import type { PrimaryAction } from './source-control-primary-action'

// Why: text primaries whose title merely repeats the label (enabled Stage All
// and Create PR) get no tooltip — pure noise. Tooltips stay only when they
// add info: disabled reasons, remote counts, the Commit shortcut, and the
// Create PR intent, whose label hides that the click also stages/commits/pushes.
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

// Why: both the commit-area split button and the header Create PR button share
// this show/hide rule, so the wrapper lives here instead of duplicating the
// Tooltip-or-plain-button branch (and the Button markup) at each call site.
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
