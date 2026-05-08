import { useDashboardData } from './useDashboardData'
import { useRetainedAgentsSync } from './useRetainedAgents'

// Why: isolate the retention subscriptions in a leaf component that renders
// null, so the high-churn slices read by useDashboardData
// (agentStatusByPaneKey + agentStatusEpoch, which tick at PTY event frequency)
// do not re-render the entire App tree. Retention must still run at the App
// level — if it only ran when a single card was mounted, "done" agents would
// vanish from the inline agents list any time the user scrolled that card
// out of view.
export default function RetainedAgentsSyncGate(): null {
  const dashboardLiveGroups = useDashboardData()
  useRetainedAgentsSync(dashboardLiveGroups)
  return null
}
