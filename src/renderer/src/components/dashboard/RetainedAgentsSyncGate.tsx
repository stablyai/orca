import { useRetainedAgentsSync } from './useRetainedAgents'

// Why: isolate the retention subscriptions in a leaf component that renders
// null, so agent-status retention work does not re-render the entire App tree.
// Retention must still run at the App level — if it only ran when a single
// card was mounted, "done" agents would vanish from the inline agents list any
// time the user scrolled that card out of view.
export default function RetainedAgentsSyncGate(): null {
  useRetainedAgentsSync()
  return null
}
