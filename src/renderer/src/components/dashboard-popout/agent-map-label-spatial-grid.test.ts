import { describe, expect, it } from 'vitest'
import {
  addAgentMapLabelBox,
  agentMapLabelGridCollides,
  type AgentMapLabelGrid
} from './agent-map-label-spatial-grid'

describe('agent map label spatial grid', () => {
  it('checks oversized boxes without expanding every covered cell', () => {
    const grid: AgentMapLabelGrid = new Map()
    addAgentMapLabelBox(grid, { left: -1_000_000, right: 1_000_000, top: -20, bottom: 20 })

    expect(agentMapLabelGridCollides(grid, { left: 0, right: 10, top: 0, bottom: 10 })).toBe(true)
    expect(
      agentMapLabelGridCollides(grid, {
        left: 2_000_000,
        right: 3_000_000,
        top: 0,
        bottom: 10
      })
    ).toBe(false)

    const normalGrid: AgentMapLabelGrid = new Map()
    addAgentMapLabelBox(normalGrid, { left: 0, right: 10, top: 0, bottom: 10 })
    expect(
      agentMapLabelGridCollides(normalGrid, {
        left: -1_000_000,
        right: 1_000_000,
        top: -20,
        bottom: 20
      })
    ).toBe(true)
  })
})
