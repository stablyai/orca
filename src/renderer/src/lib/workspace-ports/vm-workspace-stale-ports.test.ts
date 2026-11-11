import { describe, expect, it } from 'vitest'
import { vmWorkspacePortsAreStale } from './vm-workspace-stale-ports'

describe('vmWorkspacePortsAreStale', () => {
  it('hides ports while asleep and while waking', () => {
    expect(
      vmWorkspacePortsAreStale({
        runtime: { status: 'suspended', updatedAt: 10 },
        waking: false,
        scannedAt: 20
      })
    ).toBe(true)
    expect(
      vmWorkspacePortsAreStale({
        runtime: { status: 'running', updatedAt: 10 },
        waking: true,
        scannedAt: 20
      })
    ).toBe(true)
  })

  it('after the wake, hides ports until a scan newer than the wake', () => {
    const runtime = { status: 'running', updatedAt: 100 }
    expect(vmWorkspacePortsAreStale({ runtime, waking: false, scannedAt: 50 })).toBe(true)
    expect(vmWorkspacePortsAreStale({ runtime, waking: false, scannedAt: 150 })).toBe(false)
  })

  it('leaves workspaces without a VM alone', () => {
    expect(vmWorkspacePortsAreStale({ runtime: undefined, waking: false, scannedAt: 1 })).toBe(
      false
    )
  })
})
