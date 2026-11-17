import { describe, expect, it } from 'vitest'
import { computeZotzMemoryGovernorDefaults } from './zotz-memory-governor-defaults'

const GB = 1024 ** 3

describe('computeZotzMemoryGovernorDefaults', () => {
  it('derives the limits for the MSI as Windows reports its 16 GB', () => {
    const limits = computeZotzMemoryGovernorDefaults(16_937_746_432)
    expect(limits.maxConcurrentAgents).toBe(2)
    expect(limits.minFreeBytes).toBe(2_540_661_964)
    expect(limits.perAgentMaxBytes).toBe(5_928_211_251)
    expect(limits.agentBudgetBytes).toBe(11_856_422_502)
  })

  it('keeps the floors and ceilings on small and large machines', () => {
    expect(computeZotzMemoryGovernorDefaults(8 * GB)).toMatchObject({
      maxConcurrentAgents: 1,
      minFreeBytes: 2 * GB
    })
    expect(computeZotzMemoryGovernorDefaults(64 * GB)).toMatchObject({
      maxConcurrentAgents: 6,
      perAgentMaxBytes: 6 * GB
    })
  })
})
