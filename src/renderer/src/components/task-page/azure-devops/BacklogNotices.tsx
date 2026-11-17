import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { AzureDevOpsLoadNoticeLine, AzureDevOpsLoadNotices } from './LoadNotice'

export function AzureDevOpsBacklogNotices({
  unhydratedItemCount,
  truncatedAtQueryLimit = null
}: {
  /** Level items the query returned that the host could not load. */
  unhydratedItemCount: number
  /** The query's own result bound when the list came back at it, so rows beyond it are absent. */
  truncatedAtQueryLimit?: number | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const lines: React.JSX.Element[] = []
  if (truncatedAtQueryLimit !== null && truncatedAtQueryLimit > 0) {
    lines.push(
      <AzureDevOpsLoadNoticeLine key="query-limit" kind="query-limit">
        {t(
          'auto.components.TaskPage.azureDevOps.workItems.queryLimit',
          'Only the {{value0}} most recently changed work items are shown, so the filters above cannot reach the rest. Narrow the list in Azure DevOps.',
          { value0: truncatedAtQueryLimit }
        )}
      </AzureDevOpsLoadNoticeLine>
    )
  }
  if (unhydratedItemCount > 0) {
    lines.push(
      <AzureDevOpsLoadNoticeLine key="unhydrated-items" kind="unhydrated-items">
        {t(
          'auto.components.TaskPage.azureDevOps.backlog.unhydratedItems',
          '{{count}} work items couldn’t be loaded and are missing from this list. Refresh to try again.',
          {
            count: unhydratedItemCount,
            defaultValue_one:
              '{{count}} work item couldn’t be loaded and is missing from this list. Refresh to try again.'
          }
        )}
      </AzureDevOpsLoadNoticeLine>
    )
  }
  return lines.length === 0 ? null : <AzureDevOpsLoadNotices>{lines}</AzureDevOpsLoadNotices>
}
