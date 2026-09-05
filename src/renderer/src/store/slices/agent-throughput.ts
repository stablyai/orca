import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AgentThroughputSample } from '../../../../shared/agent-throughput-types'

export type AgentThroughputSlice = {
  agentThroughputByPaneKey: Record<string, AgentThroughputSample>
  /** Panes cleared since startup, by clear time; fences the startup snapshot merge. */
  agentThroughputClearedAt: Record<string, number>
  setAgentThroughput: (sample: AgentThroughputSample) => void
  clearAgentThroughput: (paneKey: string) => void
  /** Startup catch-up: a pane keeps whichever of its push or snapshot sample was observed later. */
  mergeAgentThroughputSnapshot: (samples: AgentThroughputSample[]) => void
}

export const createAgentThroughputSlice: StateCreator<AppState, [], [], AgentThroughputSlice> = (
  set
) => ({
  agentThroughputByPaneKey: {},
  agentThroughputClearedAt: {},
  setAgentThroughput: (sample) =>
    set((s) => {
      const { [sample.paneKey]: _cleared, ...clearedAt } = s.agentThroughputClearedAt
      return {
        agentThroughputByPaneKey: { ...s.agentThroughputByPaneKey, [sample.paneKey]: sample },
        agentThroughputClearedAt: clearedAt
      }
    }),
  clearAgentThroughput: (paneKey) =>
    set((s) => {
      const next = { ...s.agentThroughputByPaneKey }
      delete next[paneKey]
      return {
        agentThroughputByPaneKey: next,
        agentThroughputClearedAt: { ...s.agentThroughputClearedAt, [paneKey]: Date.now() }
      }
    }),
  mergeAgentThroughputSnapshot: (samples) =>
    set((s) => {
      const next = { ...s.agentThroughputByPaneKey }
      for (const sample of samples) {
        // Why: a snapshot pulled before a clear must not resurrect the pane it cleared.
        const clearedAt = s.agentThroughputClearedAt[sample.paneKey]
        if (clearedAt !== undefined && sample.observedAt <= clearedAt) {
          continue
        }
        const current = next[sample.paneKey]
        if (!current || current.observedAt <= sample.observedAt) {
          next[sample.paneKey] = sample
        }
      }
      return { agentThroughputByPaneKey: next }
    })
})
