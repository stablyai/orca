import { describe, expect, it, vi } from 'vitest'
import { agentMapStatusLabel } from './agent-map-node-presentation'

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) => `${key}:${fallback}`
}))

describe('agentMapStatusLabel', () => {
  it('localizes the map-only acknowledged completion state', () => {
    expect(agentMapStatusLabel('done-seen')).toBe('dashboardPopout.map.status.doneSeen:Done, seen')
  })

  it('keeps shared agent states on their existing labels', () => {
    expect(agentMapStatusLabel('working')).toBe('Working')
    expect(agentMapStatusLabel('done')).toBe('Done')
  })
})
