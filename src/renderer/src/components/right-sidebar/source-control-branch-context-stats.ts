import type { GitBranchCompareSummary, GitUpstreamStatus } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

function formatAheadOfBaseTitle(count: number, baseRef: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.f9b2441bb6',
        '1 commit ahead of {{value0}}',
        { value0: baseRef }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.b715ef615b',
        '{{value0}} commits ahead of {{value1}}',
        { value0: count, value1: baseRef }
      )
}

function formatBehindBaseTitle(count: number, baseRef: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.c1a8f3e204',
        '1 commit behind {{value0}}',
        { value0: baseRef }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.d2b9g4f315',
        '{{value0}} commits behind {{value1}}',
        { value0: count, value1: baseRef }
      )
}

export type SourceControlBranchContextStat = {
  key: string
  label: string
  title?: string
  tone: 'default' | 'ahead' | 'behind' | 'muted'
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

export function shouldShowSourceControlBranchContextRow(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined
): boolean {
  return summary != null || resolveSourceControlDisplayedBaseRef(summary, compareBaseRef) != null
}

export function buildSourceControlBranchContextStats({
  summary,
  baseRef,
  upstreamStatus
}: {
  summary: GitBranchCompareSummary
  baseRef: string
  upstreamStatus?: GitUpstreamStatus
}): SourceControlBranchContextStat[] {
  if (summary.status !== 'ready') {
    return []
  }

  const stats: SourceControlBranchContextStat[] = []

  if (upstreamStatus?.hasUpstream) {
    if (upstreamStatus.ahead > 0) {
      stats.push({
        key: 'upstream-ahead',
        label: `↑${upstreamStatus.ahead}`,
        title: formatAheadOfBaseTitle(upstreamStatus.ahead, baseRef),
        tone: 'ahead'
      })
    }
    if (upstreamStatus.behind > 0) {
      stats.push({
        key: 'upstream-behind',
        label: `↓${upstreamStatus.behind}`,
        title: formatBehindBaseTitle(upstreamStatus.behind, baseRef),
        tone: 'behind'
      })
    }
  }

  const commitsAhead = summary.commitsAhead
  if (typeof commitsAhead === 'number' && commitsAhead > 0) {
    const upstreamAhead = upstreamStatus?.hasUpstream ? upstreamStatus.ahead : 0
    if (commitsAhead !== upstreamAhead) {
      stats.push({
        key: 'compare-ahead',
        label: `↑${commitsAhead}`,
        title: formatAheadOfBaseTitle(commitsAhead, baseRef),
        tone: 'ahead'
      })
    }
  }

  return stats
}
