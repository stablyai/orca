import React from 'react'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { IssueSourcePreference } from '../../../../shared/repo-types'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export type IssueSourceSelectorProps = {
  /** Unset preferences behave as auto; untouched repos omit the stored key. */
  preference: IssueSourcePreference | undefined
  origin: GitHubOwnerRepo | null
  /** Pass upstream independently of the effective preference so choosing origin cannot hide the control. */
  upstream: GitHubOwnerRepo | null
  /** Persist explicit choices, including clicks on the auto-selected pill, so topology changes cannot move selection. */
  onChange: (preference: 'upstream' | 'origin') => void
  disabled?: boolean
  className?: string
  /** Compact shows U/O with slug tooltips; labeled is the Tasks-header default. */
  density?: 'labeled' | 'compact'
  /** Omit redundant source tooltips on issue-only surfaces; mixed issue/PR views need the routing caveat. */
  suppressTooltip?: boolean
}

type PillState = 'active' | 'inactive'

function segmentClass(state: PillState, disabled: boolean | undefined): string {
  return cn(
    // Inner segments use background state without doubling the enclosing chip’s border.
    'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium transition',
    state === 'active'
      ? 'bg-foreground/10 text-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
    disabled ? 'cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground' : ''
  )
}

// Share the outer pill styling with Tasks-header repo labels and static source indicators.
export const issueSourceChipClass =
  'inline-flex items-center gap-1 rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground'

/** Hide identical/unresolved sources; auto highlights the heuristic choice, while every click pins an explicit source. */
export default function IssueSourceSelector({
  preference,
  origin,
  upstream,
  onChange,
  disabled,
  className,
  density = 'labeled',
  suppressTooltip = false
}: IssueSourceSelectorProps): React.JSX.Element | null {
  if (!origin || !upstream) {
    return null
  }
  if (sameGitHubOwnerRepo(origin, upstream)) {
    return null
  }

  // A rendered auto selector has upstream available, so the heuristic selects it.
  const effective: 'upstream' | 'origin' =
    preference === 'upstream' || preference === 'origin' ? preference : 'upstream'

  const upstreamSlug = `${upstream.owner}/${upstream.repo}`
  const originSlug = `${origin.owner}/${origin.repo}`

  // An auto-selected pill still needs an explicit write; skip only an already persisted match.
  const persistedMatches = (target: 'upstream' | 'origin'): boolean => preference === target

  const group = (
    <div
      role="group"
      aria-label={translate(
        'auto.components.github.IssueSourceSelector.787c970baf',
        'Issue source'
      )}
      className={cn(
        'inline-flex items-center overflow-hidden rounded border border-border/40',
        className
      )}
    >
      <button
        type="button"
        aria-pressed={effective === 'upstream'}
        disabled={disabled}
        onClick={() => {
          if (disabled || persistedMatches('upstream')) {
            return
          }
          onChange('upstream')
        }}
        className={segmentClass(effective === 'upstream' ? 'active' : 'inactive', disabled)}
      >
        {density === 'compact'
          ? 'U'
          : translate('auto.components.github.IssueSourceSelector.30b2c9df91', 'Upstream')}
      </button>
      <button
        type="button"
        aria-pressed={effective === 'origin'}
        disabled={disabled}
        onClick={() => {
          if (disabled || persistedMatches('origin')) {
            return
          }
          onChange('origin')
        }}
        className={cn(
          segmentClass(effective === 'origin' ? 'active' : 'inactive', disabled),
          'border-l border-border/40'
        )}
      >
        {density === 'compact'
          ? 'O'
          : translate('auto.components.github.IssueSourceSelector.51d1608920', 'Origin')}
      </button>
    </div>
  )

  // Let issue-only callers omit the tooltip without coupling this control to page identity.
  if (suppressTooltip) {
    return group
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{group}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="max-w-[260px]">
        {translate('auto.components.github.IssueSourceSelector.d6aeb2012b', 'Showing issues from')}{' '}
        <span className="font-mono">{effective === 'upstream' ? upstreamSlug : originSlug}</span>
      </TooltipContent>
    </Tooltip>
  )
}
