import { describe, expect, it } from 'vitest'

import {
  AGENT_STATUS_2A_SERVING_READINESS,
  agentStatusRunServingGatePasses,
  advertisedAgentStatusRunCapabilities,
  isAgentStatusRunServingAdvertised
} from './agent-status-serving-readiness'

describe('agent-status run serving readiness', () => {
  it('keeps run serving unadvertised throughout 2A', () => {
    expect(isAgentStatusRunServingAdvertised(AGENT_STATUS_2A_SERVING_READINESS)).toBe(false)
    expect(advertisedAgentStatusRunCapabilities(AGENT_STATUS_2A_SERVING_READINESS)).toEqual([])
  })

  it('requires both serving readiness and an empty current-producer manifest', () => {
    const ready = { servingReady: true }
    expect(
      agentStatusRunServingGatePasses({
        readiness: ready,
        currentProducerManifest: [{ caller: 'still-legacy' }]
      })
    ).toBe(false)
    expect(agentStatusRunServingGatePasses({ readiness: ready, currentProducerManifest: [] })).toBe(
      true
    )
    expect(advertisedAgentStatusRunCapabilities(ready)).toEqual([])
  })
})
