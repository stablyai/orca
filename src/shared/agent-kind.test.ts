import { describe, expect, it } from 'vitest'

import { tuiAgentToAgentKind } from './agent-kind'
import { AGENT_KIND_VALUES, agentKindSchema } from './telemetry-events'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

describe('tuiAgentToAgentKind', () => {
  it('maps every shipped TuiAgent to a concrete telemetry kind', () => {
    const agents = Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]

    for (const agent of agents) {
      const kind = tuiAgentToAgentKind(agent)

      expect(kind).not.toBe('other')
      expect(agentKindSchema.safeParse(kind).success).toBe(true)
    }
  })

  it('keeps concrete telemetry kinds in exact sync with shipped TuiAgents', () => {
    const agents = Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]
    const mappedKinds = agents.map((agent) => tuiAgentToAgentKind(agent)).sort()
    const concreteSchemaKinds = AGENT_KIND_VALUES.filter((kind) => kind !== 'other').sort()

    expect(mappedKinds).toEqual(concreteSchemaKinds)
  })

  it('uses the product id for Claude and the TuiAgent id for Pi', () => {
    expect(tuiAgentToAgentKind('claude')).toBe('claude-code')
    expect(tuiAgentToAgentKind('pi')).toBe('pi')
  })
})
