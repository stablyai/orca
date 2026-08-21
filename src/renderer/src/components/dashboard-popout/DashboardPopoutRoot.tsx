import { useEffect, useState } from 'react'
import {
  resolveAgentDashboardInitialView,
  type AgentDashboardView
} from '../../../../shared/agent-dashboard-default-view'
import { useAppStore } from '@/store'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { useDashboardSnapshot } from './useDashboardSnapshot'

type DashboardPopoutRootProps = {
  /** The layout requested via popout.html?view=<name>. */
  view: string | null
}

/**
 * Root of the pop-out dashboard window. Subscribes to the live snapshot relayed
 * from the main window and renders the requested layout.
 */
export function DashboardPopoutRoot(_props: DashboardPopoutRootProps): React.JSX.Element {
  const snapshot = useDashboardSnapshot()
  const [view, setView] = useState<AgentDashboardView>(() =>
    resolveAgentDashboardInitialView({
      defaultWorktreeView:
        useAppStore.getState().settings?.experimentalAgentDashboardDefaultWorktreeView,
      requestedView: _props.view
    })
  )
  useEffect(() => window.api.dashboard.onViewRequested(setView), [])
  return <AgentKanbanBoard key={view} snapshot={snapshot} initialView={view} />
}
