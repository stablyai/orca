import React from 'react'
import type { GitHubOwnerRepo, IssueSourcePreference } from '../../../../shared/types'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
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
}

type PillState = 'active' | 'inactive'

function pillClass(state: PillState, disabled: boolean | undefined): string {
  return cn(
    'inline-flex items-center gap-1 border border-border/50 px-2 py-0.5 text-[10px] font-medium transition',
    'first:rounded-l-md first:border-r-0 last:rounded-r-md',
    // Why: match the weight of the neighbouring IssueSourceIndicator chip —
    // a solid-dark active pill would read as a CTA rather than a state
    // indicator. `bg-muted/60 text-foreground` sits in the same visual band
    // as the static indicator while still being clearly the active choice.
    state === 'active'
      ? 'bg-muted/60 text-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
    disabled ? 'cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground' : ''
  )
}

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
  density = 'labeled'
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

  return (
    <div
      role="group"
      aria-label="Issue source"
      className={cn('inline-flex items-center text-[10px]', className)}
    >
      <button
        type="button"
        aria-pressed={effective === 'upstream'}
        disabled={disabled}
        title={`Use upstream (${upstreamSlug})`}
        onClick={() => {
          if (disabled || effective === 'upstream') {
            return
          }
          onChange('upstream')
        }}
        className={pillClass(effective === 'upstream' ? 'active' : 'inactive', disabled)}
      >
        {density === 'compact' ? 'U' : 'Upstream'}
      </button>
      <button
        type="button"
        aria-pressed={effective === 'origin'}
        disabled={disabled}
        title={`Use origin (${originSlug})`}
        onClick={() => {
          if (disabled || effective === 'origin') {
            return
          }
          onChange('origin')
        }}
        className={pillClass(effective === 'origin' ? 'active' : 'inactive', disabled)}
      >
        {density === 'compact' ? 'O' : 'Origin'}
      </button>
    </div>
  )
}
