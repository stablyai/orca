import { describe, expect, it } from 'vitest'

import { agentKindToTuiAgent, tuiAgentToAgentKind } from './agent-kind'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

describe('agentKindToTuiAgent', () => {
  it('round-trips every shipped TuiAgent through its telemetry kind', () => {
    const agents = Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]
    for (const agent of agents) {
      expect(agentKindToTuiAgent(tuiAgentToAgentKind(agent))).toBe(agent)
    }
  })

  it('returns null for the catch-all and missing kinds', () => {
    expect(agentKindToTuiAgent('other')).toBeNull()
    expect(agentKindToTuiAgent(null)).toBeNull()
    expect(agentKindToTuiAgent(undefined)).toBeNull()
  })
})
