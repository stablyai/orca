import React from 'react'
import { useAppStore } from '@/store'
import { Workflow } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import type { LineageHiddenDescendants } from './worktree-lineage-descendants'
import {
  getLineageHiddenActivityLabel,
  getLineageHiddenActivityStatus,
  useLineageHiddenActivity
} from './worktree-lineage-hidden-activity'

// Why: mounted only while a lineage is collapsed, so expanded parents add no
// store subscription; the chip's own aria-label stays the toggle's name.
export function LineageHiddenActivityGlyph({
  hidden,
  descriptionId
}: {
  hidden: LineageHiddenDescendants
  descriptionId: string
}): React.JSX.Element {
  const showUnread = useAppStore(
    (s) => s.settings?.notifications?.showChildWorktreeUnread !== false
  )
  const unreadCount = showUnread ? hidden.unreadCount : 0
  const activity = useLineageHiddenActivity(hidden.worktreeIds)
  const status = getLineageHiddenActivityStatus(activity)
  return (
    <>
      <span className="relative inline-flex shrink-0">
        {status ? (
          <StatusIndicator status={status} showTooltip={false} className="size-2.5" />
        ) : (
          <Workflow className="size-2.5" />
        )}
        {/* Why: the cards' unread badge token, cut out of the chip surface. */}
        {unreadCount > 0 ? (
          <span
            data-lineage-hidden-unread=""
            className="pointer-events-none absolute -right-0.5 -top-0.5 size-[5px] rounded-full bg-worktree-unread ring-1 ring-worktree-sidebar"
            aria-hidden="true"
          />
        ) : null}
      </span>
      <span id={descriptionId} className="sr-only">
        {getLineageHiddenActivityLabel(activity, unreadCount)}
      </span>
    </>
  )
}

export function LineageHiddenActivityTooltipLabel({
  hidden
}: {
  hidden: LineageHiddenDescendants
}): React.JSX.Element | null {
  const showUnread = useAppStore(
    (s) => s.settings?.notifications?.showChildWorktreeUnread !== false
  )
  const activity = useLineageHiddenActivity(hidden.worktreeIds)
  const label = getLineageHiddenActivityLabel(activity, showUnread ? hidden.unreadCount : 0)
  return label ? <span className="block text-background/70">{label}</span> : null
}
