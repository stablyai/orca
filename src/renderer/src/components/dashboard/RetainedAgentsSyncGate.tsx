import { useRetainedAgentsSync } from './useRetainedAgents'

// Retain at App lifetime so scrolled-out cards keep done agents; isolate subscriptions in this null leaf to avoid App re-renders.
export default function RetainedAgentsSyncGate(): null {
  useRetainedAgentsSync()
  return null
}
