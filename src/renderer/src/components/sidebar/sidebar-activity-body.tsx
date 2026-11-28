import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import { selectRailPageHidesWorkspaceList } from '@/components/app-rail/app-rail-layout'
import type { SidebarAgentsListProps } from '../activity/sidebar/SidebarAgentsList'

// Load the shared Activity badge/list pipeline after the sidebar shell.
const SidebarAgentsList = lazyWithRetry(() => import('../activity/sidebar/SidebarAgentsList'))
const ActivityInbox = lazyWithRetry(() => import('../activity/inbox/ActivityInbox'))

/**
 * The sidebar's Activity body. Rail off: today's list, and its bell badge while closed. Rail on: the inbox, mounted
 * only while it shows, so nothing runs for Activity while it is closed or a rail page hides the list (the rail's
 * own dot covers that). Going to a rail page counts as leaving Activity.
 */
export function SidebarActivityBody({
  inbox,
  ...props
}: SidebarAgentsListProps & { inbox: boolean }): React.JSX.Element | null {
  const hiddenByRailPage = useAppStore(selectRailPageHidesWorkspaceList)
  if (!inbox) {
    return <SidebarAgentsList {...props} />
  }
  return props.active && !hiddenByRailPage ? (
    <ActivityInbox actionsTarget={props.optionsTarget} />
  ) : null
}
