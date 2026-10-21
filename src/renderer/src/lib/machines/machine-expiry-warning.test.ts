import { describe, expect, it } from 'vitest'
import type { MachineExpiryWarning } from '../../../../shared/machine-inventory'
import type { MachineMatch } from './machine-host-match'
import { getMachineExpiryWarning, getWarnableExpiry } from './machine-expiry-warning'

const NOW = Date.parse('2026-10-19T10:00:00.000Z')

function match(
  expiresAt: string | undefined,
  lifetime: 'temporary' | 'persistent' = 'temporary'
): MachineMatch {
  return {
    environmentId: null,
    snapshot: { providerKey: 'plugin:p/o', name: 'Omarchy', machines: [], pendingCreates: [] },
    machine: {
      id: 'm',
      name: 'box',
      lifetime,
      state: 'running',
      createdAt: '2026-10-19T08:00:00.000Z',
      providerKey: 'plugin:p/o',
      lastSeenAt: 0,
      ...(expiresAt ? { expiresAt } : {})
    }
  }
}

describe('machine expiry warning', () => {
  it('warns inside the last 15 minutes only', () => {
    expect(getWarnableExpiry(match('2026-10-19T10:10:00.000Z'), NOW)).not.toBeNull()
    expect(getWarnableExpiry(match('2026-10-19T10:20:00.000Z'), NOW)).toBeNull()
    expect(getWarnableExpiry(match('2026-10-19T09:59:00.000Z'), NOW)).toBeNull()
  })

  it("shows main's warning only while work is at risk or unknown", () => {
    expect(getWarnableExpiry(match('2026-10-19T10:10:00.000Z', 'persistent'), NOW)).toBeNull()
    const soon = match('2026-10-19T10:10:00.000Z')
    const warn = (workAtRisk: MachineExpiryWarning['workAtRisk']): MachineExpiryWarning => ({
      providerKey: 'plugin:p/o',
      machineId: 'm',
      name: 'box',
      expiresAt: Date.parse('2026-10-19T10:10:00.000Z'),
      workAtRisk
    })
    expect(getMachineExpiryWarning(soon, undefined, NOW)).toBeNull()
    expect(getMachineExpiryWarning(soon, warn({ uncommitted: 0, unpushed: 0 }), NOW)).toBeNull()
    expect(getMachineExpiryWarning(soon, warn({ uncommitted: 3, unpushed: 0 }), NOW)).toContain(
      '· 3 uncommitted changes'
    )
    expect(getMachineExpiryWarning(soon, warn({ uncommitted: 1, unpushed: 2 }), NOW)).toContain(
      '1 uncommitted change, 2 unpushed commits'
    )
    expect(getMachineExpiryWarning(soon, warn(null), NOW)).toContain('Couldn’t check unsaved work')
    // An extended expiry outlives the warning main raised for the old one.
    expect(
      getMachineExpiryWarning(
        match('2026-10-19T11:10:00.000Z'),
        warn({ uncommitted: 1, unpushed: 0 }),
        NOW
      )
    ).toBeNull()
  })
})
