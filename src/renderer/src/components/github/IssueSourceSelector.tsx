import React, { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { GitHubOwnerRepo, IssueSourcePreference } from '../../../../shared/types'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

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
   *  — clicking a pill always writes the explicit value so a later
   *  remote-topology change cannot silently move the selection. */
  onChange: (preference: 'upstream' | 'origin' | 'mixed') => void
  /** Disables both pills while a persist is in flight. */
  disabled?: boolean
  className?: string
  /** `'compact'` strips text from the pills and shows just "U" / "O" with
   *  slug in a tooltip. Used where horizontal space is tight (composer
   *  description line). Defaults to `'labeled'` on the Tasks header. */
  density?: 'labeled' | 'compact'
  /** Why: 'mixed' is a list concept. Single-target surfaces (Create Issue)
   *  must not offer it — there it resolves like 'auto', making the pill a
   *  silent alias for Upstream. */
  showMixed?: boolean
  /** True while a source flip's refetch is in flight: pills disable at once,
   *  the spinner shows after ~200ms (STYLEGUIDE UX rule 1). Leave undefined on
   *  surfaces that never refetch — the spinner slot only renders when wired. */
  busy?: boolean
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
// optional per-repo badge label prefix) in the same pill shape used by the
// static `IssueSourceIndicator`. Keeping the styling here means the chip
// and its segments stay visually consistent.
export const issueSourceChipClass =
  'inline-flex items-center gap-1 rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground'

/**
 * Segmented control: `Upstream | Origin | Mixed`.
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
  suppressTooltip = false,
  showMixed = false,
  busy
}: IssueSourceSelectorProps): React.JSX.Element | null {
  const busySlotReserved = busy !== undefined
  // Why: delay the visible spinner ~200ms — local flips often settle before
  // that and anything visible would read as a glitch; SSH flips get feedback.
  const [busyVisible, setBusyVisible] = useState(false)
  useEffect(() => {
    if (busy !== true) {
      setBusyVisible(false)
      return
    }
    const timer = setTimeout(() => setBusyVisible(true), 200)
    return () => clearTimeout(timer)
  }, [busy])
  if (!origin || !upstream) {
    return null
  }
  if (sameGitHubOwnerRepo(origin, upstream)) {
    return null
  }

  // Why: in `'auto'`/unset, the effective pill is whatever `getIssueOwnerRepo`
  // picks — upstream-if-present-else-origin. Since we only render here when
  // upstream exists, the heuristic resolves to upstream.
  // Why: without the Mixed pill a persisted 'mixed' resolves like 'auto', so
  // highlight the pill matching the actual target, not a hidden third state.
  const effective: 'upstream' | 'origin' | 'mixed' =
    preference === 'upstream' || preference === 'origin'
      ? preference
      : preference === 'mixed' && showMixed
        ? 'mixed'
        : 'upstream'

  const upstreamSlug = `${upstream.owner}/${upstream.repo}`
  const originSlug = `${origin.owner}/${origin.repo}`

  // Why: "pin-on-click" semantics — any click writes the explicit preference,
  // even when the pill is already active under `auto`. Short-circuiting when
  // the clicked pill already looks selected would leave `preference ===
  // undefined`, which means a later remote-topology change (upstream removed
  // or re-added) could silently move the effective source. Only short-circuit
  // when the persisted preference already matches the click.
  const persistedMatches = (target: 'upstream' | 'origin' | 'mixed'): boolean =>
    preference === target
  // Why: bind disabled the moment a flip dispatches so double-clicks can't
  // race two source swaps; the spinner is the delayed *visible* half.
  const interactionDisabled = disabled || busy === true

  const group = (
    <div
      role="group"
      aria-busy={busy === true}
      aria-label={translate(
        'auto.components.github.IssueSourceSelector.787c970baf',
        'Issue source'
      )}
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
        disabled={interactionDisabled}
        onClick={() => {
          // Why: with persisted 'mixed' and no Mixed pill this pill renders
          // active — clicking it would silently overwrite the preference.
          const rendersAsMixedAlias = preference === 'mixed' && !showMixed
          if (interactionDisabled || persistedMatches('upstream') || rendersAsMixedAlias) {
            return
          }
          onChange('upstream')
        }}
        className={segmentClass(
          effective === 'upstream' ? 'active' : 'inactive',
          interactionDisabled
        )}
      >
        {density === 'compact'
          ? 'U'
          : translate('auto.components.github.IssueSourceSelector.30b2c9df91', 'Upstream')}
      </button>
      <button
        type="button"
        aria-pressed={effective === 'origin'}
        disabled={interactionDisabled}
        onClick={() => {
          if (interactionDisabled || persistedMatches('origin')) {
            return
          }
          onChange('origin')
        }}
        className={cn(
          segmentClass(effective === 'origin' ? 'active' : 'inactive', interactionDisabled),
          // Why: 1px divider between segments, matching the outer chip border.
          'border-l border-border/40'
        )}
      >
        {density === 'compact'
          ? 'O'
          : translate('auto.components.github.IssueSourceSelector.51d1608920', 'Origin')}
      </button>
      {showMixed ? (
        <button
          type="button"
          aria-pressed={effective === 'mixed'}
          disabled={interactionDisabled}
          onClick={() => {
            if (interactionDisabled || persistedMatches('mixed')) {
              return
            }
            onChange('mixed')
          }}
          className={cn(
            segmentClass(effective === 'mixed' ? 'active' : 'inactive', interactionDisabled),
            'border-l border-border/40'
          )}
        >
          {density === 'compact'
            ? 'M'
            : translate('auto.components.github.IssueSourceSelector.9d1ff63799', 'Mixed')}
        </button>
      ) : null}
      {/* Why: reserved footprint — the chip must not resize mid-action when
          the spinner becomes visible (UX rule 1). */}
      {busySlotReserved ? (
        <span className="inline-flex w-4 items-center justify-center self-stretch border-l border-border/40">
          <LoaderCircle
            aria-hidden="true"
            className={cn(
              'size-3 text-muted-foreground',
              busyVisible ? 'animate-spin' : 'invisible'
            )}
          />
        </span>
      ) : null}
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
        {effective === 'mixed' ? (
          translate(
            'auto.components.github.IssueSourceSelector.b47b195370',
            'Showing issues from origin and upstream merged'
          )
        ) : (
          <>
            {translate(
              'auto.components.github.IssueSourceSelector.d6aeb2012b',
              'Showing issues from'
            )}{' '}
            <span className="font-mono">
              {effective === 'upstream' ? upstreamSlug : originSlug}
            </span>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
