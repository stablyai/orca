import React from 'react'
import type { GitHubOwnerRepo, IssueSourcePreference } from '../../../../shared/types'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type IssueSourceSelectorProps = {
  /** The repo's persisted preference (`undefined` is rendered identically to
   *  `'auto'` — storage leaves the key off for never-touched repos). */
  preference: IssueSourcePreference | undefined
  /** Origin owner/repo as resolved from the repo's `origin` remote. */
  origin: GitHubOwnerRepo | null
  /** Upstream owner/repo as resolved from the repo's `upstream` remote, or
   *  `null` when the repo has no upstream remote. Passed independently of
   *  the currently-effective preference so the selector can keep rendering
   *  after the user picks 'origin' — otherwise choosing origin would hide
   *  the control and the user would have to edit `.git/config` to get it
   *  back. */
  upstream: GitHubOwnerRepo | null
  /** Invoked with the new explicit preference. Never called with `'auto'`
   *  — clicking either pill always writes the explicit value so a later
   *  remote-topology change cannot silently move the selection. */
  onChange: (preference: 'upstream' | 'origin') => void
  /** Disables both pills while a persist is in flight. */
  disabled?: boolean
  className?: string
  /** `'compact'` strips text from the pills and shows just "U" / "O" with
   *  slug in a tooltip. Used where horizontal space is tight (composer
   *  description line). Defaults to `'labeled'` on the Tasks header. */
  density?: 'labeled' | 'compact'
  /** Suppresses the "Issues from <slug>" hover tooltip. Passed by callers on
   *  surfaces that only act on issues (e.g. the Create Issue composer) where
   *  the caveat is implicit — on mixed surfaces like the Tasks header the
   *  tooltip is important because the same page also lists PRs, which the
   *  selector does NOT affect. */
  suppressTooltip?: boolean
}

type PillState = 'active' | 'inactive'

function segmentClass(state: PillState, disabled: boolean | undefined): string {
  return cn(
    // Why: segments live *inside* an outer chip (see `containerClass` below)
    // so they deliberately carry no border of their own — a second border
    // here would double-stroke the chip outline and look heavy. Active state
    // is expressed by a slightly darker inner background that sits one step
    // above the chip's own `bg-muted/40`.
    'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium transition',
    state === 'active'
      ? 'bg-foreground/10 text-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
    disabled ? 'cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground' : ''
  )
}

// Why: exported so the Tasks-header row can wrap the selector (and the
// optional per-repo dot-label prefix) in the same pill shape used by the
// static `IssueSourceIndicator`. Keeping the styling here means the chip
// and its segments stay visually consistent.
export const issueSourceChipClass =
  'inline-flex items-center gap-1 rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground'

/**
 * Two-pill segmented control: `Upstream | Origin`.
 *
 * Why this renders nothing when there's no divergence to toggle:
 *   - `origin` unresolved (non-GitHub remote): nothing to offer.
 *   - `upstream` null (no upstream remote configured): the heuristic already
 *     resolves to origin and any click would be a no-op.
 *   - upstream and origin point at the same slug (case-insensitive): no
 *     information to convey, matches the indicator's suppression rule.
 *
 * Why a third `'auto'` pill is not shown: `'auto'` is *the absence of an
 * explicit choice*, not a visual state the user would click. It's expressed
 * by highlighting whichever pill the heuristic currently resolves to. Any
 * click writes the explicit preference so later remote-topology changes
 * cannot silently move the effective source.
 */
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

  // Why: in `'auto'`/unset, the effective pill is whatever `getIssueOwnerRepo`
  // picks — upstream-if-present-else-origin. Since we only render here when
  // upstream exists, the heuristic resolves to upstream.
  const effective: 'upstream' | 'origin' =
    preference === 'upstream' || preference === 'origin' ? preference : 'upstream'

  const upstreamSlug = `${upstream.owner}/${upstream.repo}`
  const originSlug = `${origin.owner}/${origin.repo}`

  // Why: "pin-on-click" semantics — any click writes the explicit preference,
  // even when the pill is already active under `auto`. Short-circuiting when
  // the clicked pill already looks selected would leave `preference ===
  // undefined`, which means a later remote-topology change (upstream removed
  // or re-added) could silently move the effective source. Only short-circuit
  // when the persisted preference already matches the click.
  const persistedMatches = (target: 'upstream' | 'origin'): boolean => preference === target

  const group = (
    <div
      role="group"
      aria-label="Issue source"
      className={cn(
        // Why: an inner rounded track with subtle divider between segments.
        // Thin border matches the outer chip's border weight so the control
        // reads as part of the chip rather than a nested surface.
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
        {density === 'compact' ? 'U' : 'Upstream'}
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
          // Why: 1px divider between segments, matching the outer chip border.
          'border-l border-border/40'
        )}
      >
        {density === 'compact' ? 'O' : 'Origin'}
      </button>
    </div>
  )

  // Why: on surfaces where only issues are ever relevant (Create Issue
  // composer) the "Issues from <slug>" hover text is redundant and can even
  // mislead by implying a PR/issue split the user isn't thinking about. Let
  // the caller opt out via `suppressTooltip` rather than branching on page
  // identity inside this component.
  if (suppressTooltip) {
    return group
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{group}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="max-w-[260px]">
        Showing issues from{' '}
        <span className="font-mono">{effective === 'upstream' ? upstreamSlug : originSlug}</span>
      </TooltipContent>
    </Tooltip>
  )
}
