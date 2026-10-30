import React from 'react'
import { AlertCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/**
 * What the board is NOT showing faithfully: Azure DevOps itself prompts about
 * states that map to no column, and shows the cards it could load rather than
 * none, so a shortfall has to be visible here too.
 */
export type AzureDevOpsBoardNoticesProps = {
  /** Cards whose column value matched nothing, parked in the first in-progress column. */
  unplacedCount: number
  /** Cards the query returned that the host could not load. */
  unhydratedItemCount: number
  /** Cards whose off-board parent could not be loaded, so their Parent row is missing. */
  unhydratedParentCount: number
}

const NOTICE_CLASS =
  'flex items-center gap-2 rounded-md border border-status-warning-border bg-status-warning-background px-2 py-1 text-[11px] text-status-warning-text'

function NoticeLine({
  kind,
  children
}: {
  kind: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-board-notice={kind} className={NOTICE_CLASS}>
      <AlertCircle className="size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

export function AzureDevOpsBoardNotices(
  props: AzureDevOpsBoardNoticesProps
): React.JSX.Element | null {
  const lines: React.JSX.Element[] = []
  if (props.unplacedCount > 0) {
    lines.push(
      <NoticeLine key="unmapped" kind="unmapped">
        {translate(
          'auto.components.TaskPage.azureDevOps.board.unmappedCards',
          '{{count}} cards are not mapped to a column, so they are shown in the first in-progress column.',
          {
            count: props.unplacedCount,
            defaultValue_one:
              '{{count}} card is not mapped to a column, so it is shown in the first in-progress column.'
          }
        )}
      </NoticeLine>
    )
  }
  if (props.unhydratedItemCount > 0) {
    lines.push(
      <NoticeLine key="unhydrated-items" kind="unhydrated-items">
        {translate(
          'auto.components.TaskPage.azureDevOps.board.unhydratedCards',
          '{{count}} cards couldn’t be loaded and are missing from the board. Refresh to try again.',
          {
            count: props.unhydratedItemCount,
            defaultValue_one:
              '{{count}} card couldn’t be loaded and is missing from the board. Refresh to try again.'
          }
        )}
      </NoticeLine>
    )
  }
  if (props.unhydratedParentCount > 0) {
    lines.push(
      <NoticeLine key="unhydrated-parents" kind="unhydrated-parents">
        {translate(
          'auto.components.TaskPage.azureDevOps.board.unhydratedParents',
          '{{count}} parent work items couldn’t be loaded, so some cards show no parent.',
          {
            count: props.unhydratedParentCount,
            defaultValue_one:
              '{{count}} parent work item couldn’t be loaded, so some cards show no parent.'
          }
        )}
      </NoticeLine>
    )
  }
  return lines.length === 0 ? null : (
    <div data-board-notices className="flex shrink-0 flex-col gap-1 px-2 pt-2">
      {lines}
    </div>
  )
}
