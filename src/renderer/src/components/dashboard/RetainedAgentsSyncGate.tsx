import { useDashboardData } from './useDashboardData'
import { useRetainedAgentsSync } from './useRetainedAgents'

// Why: isolate the dashboard retention subscriptions in a leaf component that
// renders null, so the high-churn slices read by useDashboardData
// (agentStatusByPaneKey + agentStatusEpoch, which tick at PTY event frequency)
// do not re-render the entire App tree. Retention must still run at the App
// level — if it only ran when the dashboard is mounted, "done" agents would
// vanish from the sidebar hovercard whenever the panel is collapsed.
//
// The hooks inside still early-return when the experimentalAgentDashboard
// setting is off, so this gate is cheap when the feature is disabled.
export default function RetainedAgentsSyncGate(): null {
  const dashboardLiveGroups = useDashboardData()
  useRetainedAgentsSync(dashboardLiveGroups)
  return null
}
