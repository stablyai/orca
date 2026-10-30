import { useCallback } from 'react'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { YouTrackIssue } from '../../../../shared/youtrack-types'
import { isYouTrackLookupTextFor } from '../../../../shared/youtrack-issue-reference'
import { buildYouTrackLinkedWorkItem } from './youtrack-workspace'

type ApplyIssueSource = (
  linkedItem: LinkedWorkItemSummary,
  sourceContext: null,
  nameIsLookupText: boolean
) => void

export function useYouTrackIssueSelect(
  applyIssueSource: ApplyIssueSource,
  name: string
): (issue: YouTrackIssue) => void {
  return useCallback(
    (issue: YouTrackIssue): void =>
      // Why: the typed ID, ID prefix, or URL that found this issue is lookup text, not a chosen name.
      applyIssueSource(
        buildYouTrackLinkedWorkItem(issue),
        null,
        isYouTrackLookupTextFor(name, issue)
      ),
    [applyIssueSource, name]
  )
}
