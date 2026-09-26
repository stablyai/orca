import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { agentStatusEntryEqual } from './state-equality-core'

const mainAgent = { state: 'done', stateStartedAt: 1_000 } as const

const base: AgentStatusEntry = {
  state: 'done',
  prompt: 'fix the build',
  updatedAt: 1_000,
  stateStartedAt: 1_000,
  paneKey: 'tab-1:leaf-1',
  agentType: 'claude',
  stateHistory: [],
  mainAgent
}

describe('agentStatusEntryEqual', () => {
  it('treats identical rows as equal', () => {
    expect(agentStatusEntryEqual(base, { ...base, mainAgent: { ...mainAgent } })).toBe(true)
  })

  it('sees a change to only the main agent fact', () => {
    expect(
      agentStatusEntryEqual(base, {
        ...base,
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1_000 }
      })
    ).toBe(false)
  })
})
