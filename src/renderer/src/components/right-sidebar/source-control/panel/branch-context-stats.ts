import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import { translate } from '@/i18n/i18n'

function formatAheadOfTitle(count: number, ref: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsAhead_one',
        '{{count}} commit ahead of {{ref}}',
        { count, ref }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsAhead_other',
        '{{count}} commits ahead of {{ref}}',
        { count, ref }
      )
}

function formatBehindOfTitle(count: number, ref: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsBehind_one',
        '{{count}} commit behind {{ref}}',
        { count, ref }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.compareBaseCommitsBehind_other',
        '{{count}} commits behind {{ref}}',
        { count, ref }
      )
}

// Reserve green/red for line totals; coloring commit arrows too would make adjacent unlike quantities look combined.
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

// Drop Git namespace prefixes but retain remote qualification to distinguish multi-remote bases.
export function formatSourceControlRefLabel(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
}

// Require a displayable base, matching the row component's guard.
export function shouldShowSourceControlBranchContextRow(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined
): boolean {
  return resolveSourceControlDisplayedBaseRef(summary, compareBaseRef) != null
}

// Toolbar chrome may show head identity without a compare base.
export function shouldShowSourceControlBranchContextChrome(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined,
  headDisplay: WorktreeGitIdentityDisplay | null | undefined
): boolean {
  return shouldShowSourceControlBranchContextRow(summary, compareBaseRef) || headDisplay != null
}

// Show both directions against the named base so rebased branches also reveal commits behind it.
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
