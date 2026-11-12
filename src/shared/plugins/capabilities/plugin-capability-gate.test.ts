import { describe, expect, it, vi } from 'vitest'

vi.mock('../workers/plugin-host-api', () => ({
  getPluginHostMethodSpec: (name: string) =>
    name === 'demo.proposed'
      ? { proposed: true, surfaces: ['worker'], capability: 'workspace:read' }
      : null
}))

const { gatePluginHostCall } = await import('./plugin-capability-gate')

describe('proposed host methods', () => {
  it('admit development plugins only', () => {
    const subject = { grantedCapabilities: ['workspace:read' as const], surface: 'worker' as const }
    expect(gatePluginHostCall({ ...subject, allowProposed: true }, 'demo.proposed')).toEqual({
      granted: true
    })
    expect(gatePluginHostCall(subject, 'demo.proposed')).toEqual({
      granted: false,
      code: 'not_permitted',
      error: 'method demo.proposed is proposed; development plugins only'
    })
  })
})
