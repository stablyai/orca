import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { getAgentDotState } from './worktree-card-agent-summary'

// Why: getAgentDotState only reads state + entry.{interrupted,compacting}, so a
// narrow fixture keeps the test focused on the promotion rules without pulling
// in the full TerminalTab/lineage shape.
function makeAgent(
  state: AgentStatusState | 'idle',
  entry: Partial<AgentStatusEntry> = {}
): DashboardAgentRowData {
  return { state, entry: entry as AgentStatusEntry } as DashboardAgentRowData
}

describe('getAgentDotState', () => {
  it('promotes a working row flagged compacting to the compacting dot state', () => {
    expect(getAgentDotState(makeAgent('working', { compacting: true }))).toBe('compacting')
  })

  it('leaves a plain working row as working', () => {
    expect(getAgentDotState(makeAgent('working', { compacting: false }))).toBe('working')
  })

  it('does not resurrect a decayed (idle) row via a stale compacting flag', () => {
    // Why: buildWorktreeAgentRows decays a stale working row to 'idle' via
    // agent.state while entry.compacting can still read true — the row must
    // stay idle, not flip back to a live "Compacting".
    expect(getAgentDotState(makeAgent('idle', { compacting: true }))).toBe('idle')
  })

  it('prefers interrupted over compacting', () => {
    expect(getAgentDotState(makeAgent('working', { compacting: true, interrupted: true }))).toBe(
      'interrupted'
    )
  })
})
