import React from 'react'
import type { GitHubOwnerRepo } from '../../../../shared/types'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { cn } from '@/lib/utils'

export type IssueSourceIndicatorProps = {
  /** Resolved issue-source owner/repo. `null` means the source hasn't been
   *  determined yet (pre-IPC-response) or the repo has no GitHub remote. */
  issues: GitHubOwnerRepo | null
  /** Resolved PR-source owner/repo. Used for the suppression rule. */
  prs: GitHubOwnerRepo | null
  /** Controls grammatical number of the label prefix. `'list'` (default) is
   *  used on the Tasks view header where the chip annotates a plural list
   *  of issues. `'item'` is used on detail surfaces where the chip annotates
   *  a single issue (e.g. the detail dialog). Suppression rules are
   *  identical across variants. */
  variant?: 'list' | 'item'
  /** Local repo this indicator describes. Only rendered when provided — the
   *  caller passes it when multiple repos are in scope and chips would
   *  otherwise be ambiguous (which local repo does "issues from X/Y" map to?).
   *  Single-repo callers omit it so the chip stays compact. */
  localRepo?: { displayName: string; color: string }
  className?: string
}

// Why: host-agnostic copy per parent design doc §2 — never mention "GitHub"
// and never leak the local remote name ("upstream" / "origin"). The slug
// alone is what the user needs to verify before filing an issue or using a
// task as a work-item source. Leaking the remote name would imply Orca
// maintains a stable mapping between UI labels and git config, which is not
// something we want to promise.
const LABEL_PREFIX_LIST = 'Issues from '
const LABEL_PREFIX_ITEM = 'Issue from '

export function sameGitHubOwnerRepo(
  left: GitHubOwnerRepo | null,
  right: GitHubOwnerRepo | null
): boolean {
  if (!left || !right) {
    return false
  }
  // Why: GitHub treats owner/repo names case-insensitively, so remotes with
  // different casing (e.g. StablyAI/Orca vs stablyai/orca) resolve to the
  // same repo and must suppress the indicator.
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  )
}

/**
 * Renders an issue-source chip (e.g. "Issues from {owner}/{repo}") when
 * issues and PRs resolve to different repos. The `variant` prop selects
 * plural "Issues from" for list surfaces and singular "Issue from" for
 * detail surfaces. Hidden when:
 *   - either source is `null` (loading / non-GitHub remote)
 *   - both sources deep-equal the same slug (no information to convey)
 *
 * The load-state check is the parent design doc §2 requirement: no skeleton
 * during the one IPC round-trip — the list renders its own loading UI.
 */
export default function IssueSourceIndicator({
  issues,
  prs,
  variant = 'list',
  localRepo,
  className
}: IssueSourceIndicatorProps): React.JSX.Element | null {
  if (!issues || !prs) {
    return null
  }
  if (sameGitHubOwnerRepo(issues, prs)) {
    return null
  }
  const slug = `${issues.owner}/${issues.repo}`
  const prefix = variant === 'item' ? LABEL_PREFIX_ITEM : LABEL_PREFIX_LIST
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground',
        className
      )}
      title={localRepo ? `${localRepo.displayName}: ${prefix}${slug}` : `${prefix}${slug}`}
    >
      {localRepo ? (
        // Why: when multiple repos are selected, a bare "Issues from X/Y" chip
        // doesn't tell the user which local repo it describes. The dot-label
        // prefix pins the chip to the same visual identity used elsewhere in
        // the Tasks view (row disambiguator, composer target dropdown).
        <RepoDotLabel
          name={localRepo.displayName}
          color={localRepo.color}
          dotClassName="size-1.5"
          className="text-[10px] text-muted-foreground"
        />
      ) : null}
      <span className="shrink-0">{prefix}</span>
      <span className="font-mono text-foreground/80">{slug}</span>
    </span>
  )
}
