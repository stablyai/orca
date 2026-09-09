import React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  resolveAutomationListEmptyState,
  type AutomationListEmptyStateInput
} from './automation-list-empty-state'
import {
  recoveryActionLabel,
  type AutomationHostRecoveryAction
} from './automation-host-status-descriptors'

/** Renders whichever empty/partial/failure state the list is in; nothing when rows exist. */

export type AutomationListEmptyViewProps = AutomationListEmptyStateInput & {
  onRecover?: (action: AutomationHostRecoveryAction) => void
  className?: string
}

export function AutomationListEmptyView({
  onRecover,
  className,
  ...input
}: AutomationListEmptyViewProps): React.JSX.Element | null {
  const state = resolveAutomationListEmptyState(input)
  const recovery = state.recovery
  if (state.kind === 'rows') {
    return null
  }

  return (
    <div
      data-empty-state={state.kind}
      className={cn(
        'flex flex-col items-center gap-1.5 px-6 py-10 text-center text-muted-foreground',
        className
      )}
    >
      <p className="text-sm text-foreground">{state.title}</p>
      {state.detail ? <p className="text-xs">{state.detail}</p> : null}
      {recovery && onRecover ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1.5"
          onClick={() => onRecover(recovery)}
        >
          {recoveryActionLabel(recovery)}
        </Button>
      ) : null}
    </div>
  )
}
