import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import type { SidebarAgentsListProps } from '../activity/sidebar/SidebarAgentsList'

// Load the shared Activity badge/list pipeline after the sidebar shell.
const SidebarAgentsList = lazyWithRetry(() => import('../activity/sidebar/SidebarAgentsList'))
const ActivityInbox = lazyWithRetry(() => import('../activity/inbox/ActivityInbox'))

/**
 * The sidebar's Activity body. Rail off: today's list, and its bell badge while closed. Rail on: the inbox, mounted
 * only while open, so nothing runs for Activity while it is closed (the rail's own dot covers that).
 */
export function SidebarActivityBody({
  inbox,
  ...props
}: SidebarAgentsListProps & { inbox: boolean }): React.JSX.Element | null {
  if (!inbox) {
    return <SidebarAgentsList {...props} />
  }
  return props.active ? <ActivityInbox actionsTarget={props.optionsTarget} /> : null
}
