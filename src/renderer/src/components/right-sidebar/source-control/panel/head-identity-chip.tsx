import React from 'react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

type OperationIdentity = Extract<WorktreeGitIdentityDisplay, { kind: 'operation' }>

/** Short qualifier appended to the branch name while an operation replays commits. */
export function operationIdentityQualifier(operation: OperationIdentity['operation']): string {
  if (operation === 'rebase') {
    return translate(
      'auto.components.right.sidebar.source.control.panel.head.identity.chip.1a7c4e9b30',
      'rebasing'
    )
  }
  if (operation === 'merge') {
    return translate(
      'auto.components.right.sidebar.source.control.panel.head.identity.chip.2f5d81c744',
      'merging'
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.panel.head.identity.chip.3b9e027a51',
    'cherry-picking'
  )
}

/** Flow label for the "head → base" accessible grouping. */
export function resolveHeadFlowLabel(
  display: WorktreeGitIdentityDisplay | null | undefined
): string | null {
  if (display?.kind === 'branch') {
    return display.branchName
  }
  if (display?.kind === 'operation') {
    return `${display.branchName} · ${operationIdentityQualifier(display.operation)}`
  }
  if (display?.kind === 'detached') {
    return display.sourceControlLabel
  }
  return null
}

/**
 * Truncated branch chip with the full text in a tooltip. `block` is load-bearing:
 * `truncate` clips nothing on an inline box, so an inline span would let long names
 * run under the line-total chip. Native title omitted — Radix already shows the text.
 */
function TruncatedIdentityChip({
  ariaLabel,
  tooltip,
  operation,
  children
}: {
  ariaLabel: string
  tooltip: string
  operation?: OperationIdentity['operation']
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block min-w-0 max-w-full truncate rounded-sm font-mono text-[10.5px] font-medium text-foreground/90 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          tabIndex={0}
          aria-label={ariaLabel}
          data-testid="source-control-head-identity"
          data-operation={operation}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-all font-mono">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function OperationIdentityChip({ display }: { display: OperationIdentity }): React.JSX.Element {
  const qualifier = operationIdentityQualifier(display.operation)
  const ariaLabel = translate(
    'auto.components.right.sidebar.source.control.panel.head.identity.chip.4c1a63f8d2',
    'Current branch: {{value0}} ({{value1}})',
    { value0: display.branchName, value1: qualifier }
  )
  // Why: the raw SHA is still the ground truth for a detached mid-operation HEAD;
  // it moves to the tooltip so the chip can name the branch instead.
  const tooltip = display.shortHead
    ? translate(
        'auto.components.right.sidebar.source.control.panel.head.identity.chip.5d2b74a9e3',
        '{{value0}} — HEAD is detached at {{value1}} until the operation finishes.',
        { value0: display.branchName, value1: display.head || display.shortHead }
      )
    : display.branchName

  return (
    <TruncatedIdentityChip ariaLabel={ariaLabel} tooltip={tooltip} operation={display.operation}>
      {display.branchName}
      <span className="text-amber-600 dark:text-amber-400">{` · ${qualifier}`}</span>
    </TruncatedIdentityChip>
  )
}

export function HeadIdentity({
  display
}: {
  display: WorktreeGitIdentityDisplay
}): React.JSX.Element {
  if (display.kind === 'detached') {
    return (
      <DetachedHeadBadge
        display={display}
        side="bottom"
        // Why: tooltip carries the full detached explanation; keep it keyboard-reachable.
        tabIndex={0}
        className="min-w-0 max-w-full shrink"
      />
    )
  }

  if (display.kind === 'operation') {
    return <OperationIdentityChip display={display} />
  }

  const branchAriaLabel = translate(
    'auto.components.right.sidebar.SourceControl.a4e93c21d7',
    'Current branch: {{value0}}',
    { value0: display.branchName }
  )

  // Why: focusable + tooltip so truncated long branch names stay discoverable.
  return (
    <TruncatedIdentityChip ariaLabel={branchAriaLabel} tooltip={display.branchName}>
      {display.branchName}
    </TruncatedIdentityChip>
  )
}
