import React from 'react'
import { translate } from '@/i18n/i18n'
import { AzureDevOpsLoadNoticeLine, AzureDevOpsLoadNotices } from './LoadNotice'

export function AzureDevOpsBacklogNotices({
  unhydratedItemCount
}: {
  /** Level items the query returned that the host could not load. */
  unhydratedItemCount: number
}): React.JSX.Element | null {
  if (unhydratedItemCount <= 0) {
    return null
  }
  return (
    <AzureDevOpsLoadNotices>
      <AzureDevOpsLoadNoticeLine kind="unhydrated-items">
        {translate(
          'auto.components.TaskPage.azureDevOps.backlog.unhydratedItems',
          '{{count}} work items couldn’t be loaded and are missing from this list. Refresh to try again.',
          {
            count: unhydratedItemCount,
            defaultValue_one:
              '{{count}} work item couldn’t be loaded and is missing from this list. Refresh to try again.'
          }
        )}
      </AzureDevOpsLoadNoticeLine>
    </AzureDevOpsLoadNotices>
  )
}
