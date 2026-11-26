import React, { useId } from 'react'
import { Bell } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useActivityInboxDot } from '@/components/activity/inbox/use-activity-inbox-dot'
import {
  APP_RAIL_ICON_SIZE,
  APP_RAIL_ICON_STROKE_WIDTH,
  AppRailButton,
  RailItem
} from './AppRailButton'

/** Activity's rail button, right under Workspaces: a bell, with the unread dot when the inbox has something. */
export function ActivityRailButton({
  active,
  dotMounted,
  expanded,
  controls,
  tabStop,
  onClick
}: {
  active: boolean
  /** Only while the list's rows are mounted, as the rail-off badge is, so a collapsed list does no new work. */
  dotMounted: boolean
  expanded: boolean | undefined
  controls: string | undefined
  tabStop: boolean
  onClick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('appRail.activity', 'Activity')
  const dotId = useId()
  return (
    <RailItem tooltip={label}>
      <AppRailButton
        itemId="activity"
        className="relative"
        icon={
          <>
            <Bell size={APP_RAIL_ICON_SIZE} strokeWidth={APP_RAIL_ICON_STROKE_WIDTH} aria-hidden />
            {dotMounted ? <ActivityRailDot id={dotId} /> : null}
          </>
        }
        label={label}
        active={active}
        aria-expanded={expanded}
        aria-controls={controls}
        // The button's name stays "Activity"; the dot's text describes it while it shows.
        aria-describedby={dotMounted ? dotId : undefined}
        tabStop={tabStop}
        onClick={onClick}
      />
    </RailItem>
  )
}

/** Its own leaf, so a change in what needs you re-renders only the dot and never the rail. */
const ActivityRailDot = React.memo(function ActivityRailDot({
  id
}: {
  id: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hasActivity = useActivityInboxDot()
  if (!hasActivity) {
    return null
  }
  return (
    <>
      <span id={id} className="sr-only">
        {t('appRail.activityNew', 'New activity')}
      </span>
      <span
        aria-hidden
        // The workspace cards' unread dot, ringed in the rail's color so it reads as cut out of the bell.
        className="pointer-events-none absolute top-[5px] right-[5px] size-[7px] rounded-full bg-unread ring-2 ring-worktree-sidebar"
      />
    </>
  )
})
