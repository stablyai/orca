import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { translate } from '@/i18n/i18n'

function formatAheadOfTitle(count: number, ref: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsAheadOne',
        '1 commit ahead of {{ref}}',
        { ref }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsAheadOther',
        '{{count}} commits ahead of {{ref}}',
        { count, ref }
      )
}

function formatBehindOfTitle(count: number, ref: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsBehindOne',
        '1 commit behind {{ref}}',
        { ref }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsBehindOther',
        '{{count}} commits behind {{ref}}',
        { count, ref }
      )
}

// Why: the counts carry no color of their own. Green and red are reserved for the
// line-total chip beside them — an `↑1` in added-green next to `+1,114` reads as one
// quantity when they count different things (commits vs lines).
export type SourceControlBranchContextStat = {
  key: string
  label: string
  title: string
}

export function resolveSourceControlDisplayedBaseRef(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined
): string | null {
  const summaryRef = summary?.baseRef?.trim()
  if (summaryRef) {
    return summaryRef
  }
  const configuredRef = compareBaseRef?.trim()
  return configuredRef || null
}

// Why: context-row labels should stay scannable — drop git namespace prefixes
// but keep remote qualification (origin/main) so multi-remote bases stay distinct.
export function formatSourceControlRefLabel(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
}

// Why: the compare row needs a displayable base; a summary alone with an empty
// baseRef would still fail the component's displayedBaseRef guard.
export function shouldShowSourceControlBranchContextRow(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined
): boolean {
  return resolveSourceControlDisplayedBaseRef(summary, compareBaseRef) != null
}

// Why: head-only identity still mounts when there is no base, so toolbar chrome
// visibility is "base OR head" — not base alone.
export function shouldShowSourceControlBranchContextChrome(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined,
  headDisplay: WorktreeGitIdentityDisplay | null | undefined
): boolean {
  return shouldShowSourceControlBranchContextRow(summary, compareBaseRef) || headDisplay != null
}

// Why: both directions, on the line that names the ref they measure. Ahead alone hid
// the case this row exists for — a rebased branch that has also fallen behind its base.
export function buildSourceControlCompareBaseStats(
  summary: GitBranchCompareSummary | null | undefined,
  baseRef: string
): SourceControlBranchContextStat[] {
  if (summary?.status !== 'ready') {
    return []
  }
  const baseLabel = formatSourceControlRefLabel(baseRef)
  const stats: SourceControlBranchContextStat[] = []
  const commitsAhead = summary.commitsAhead
  if (typeof commitsAhead === 'number' && commitsAhead > 0) {
    stats.push({
      key: 'compare-ahead',
      label: `↑${commitsAhead}`,
      title: formatAheadOfTitle(commitsAhead, baseLabel)
    })
  }
  const commitsBehind = summary.commitsBehind
  if (typeof commitsBehind === 'number' && commitsBehind > 0) {
    stats.push({
      key: 'compare-behind',
      label: `↓${commitsBehind}`,
      title: formatBehindOfTitle(commitsBehind, baseLabel)
    })
  }
  return stats
}
