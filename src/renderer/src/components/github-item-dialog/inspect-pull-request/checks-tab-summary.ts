import { CircleDashed } from 'lucide-react'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel/check-presentation'
import type { getCheckCounts } from '@/components/pr-check-counts'

export function getChecksTabSummaryPresentation(counts: ReturnType<typeof getCheckCounts>): {
  SummaryIcon: (typeof CHECK_ICON)[keyof typeof CHECK_ICON] | typeof CircleDashed
  summaryColor: string
} {
  // All-neutral checks remain unresolved; a nonempty list does not imply any check passed.
  const SummaryIcon =
    counts.failing > 0
      ? CHECK_ICON.failure
      : counts.needsAction > 0
        ? CHECK_ICON.action_required
        : counts.pending > 0
          ? CHECK_ICON.pending
          : counts.passing > 0
            ? CHECK_ICON.success
            : CircleDashed
  const summaryColor =
    counts.failing > 0
      ? CHECK_COLOR.failure
      : counts.needsAction > 0
        ? CHECK_COLOR.action_required
        : counts.pending > 0
          ? CHECK_COLOR.pending
          : counts.passing > 0
            ? CHECK_COLOR.success
            : 'text-muted-foreground'
  return { SummaryIcon, summaryColor }
}
