import { describe, expect, it } from 'vitest'
import { parseRemoteMachineRecord, parseRemoteMachineSnapshots } from './remote-machine-snapshots'

const PROVIDER = 'plugin:omarchy/omarchy'

function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'box-1',
    name: 'omarchy-dev',
    providerKey: PROVIDER,
    lifetime: 'persistent',
    state: 'running',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: 5,
    sshTargetId: 'machine-a',
    ...extra
  }
}

describe('parseRemoteMachineSnapshots', () => {
  it('keeps what this build knows from a newer server and drops only unreadable rows', () => {
    const [snapshot] =
      parseRemoteMachineSnapshots([
        {
          providerKey: PROVIDER,
          name: 'Omarchy',
          capabilities: { verbs: ['wake', 'teleport'], lifetimes: ['persistent', 'forever'] },
          machines: [row({ state: 'hibernating', lifetime: 'eternal', glow: true }), { id: 7 }],
          pendingCreates: 'later',
          futureField: { anything: true }
        }
      ]) ?? []
    expect(snapshot?.machines).toHaveLength(1)
    expect(snapshot?.machines[0]).toMatchObject({
      id: 'box-1',
      state: 'unknown',
      lifetime: 'persistent',
      sshTargetId: 'machine-a'
    })
    expect(snapshot?.capabilities?.verbs).toEqual(['wake'])
    expect(snapshot?.capabilities?.lifetimes).toEqual(['persistent'])
    expect(snapshot?.pendingCreates).toEqual([])
  })

  it('never carries a paired server’s access, and rejects a reply that is not a list', () => {
    const record = parseRemoteMachineRecord(
      row({ access: { kind: 'ssh', host: 'internal', port: 22, user: 'me', projectRoot: '/w' } })
    )
    expect(record).not.toHaveProperty('access')
    expect(parseRemoteMachineSnapshots({ machines: [] })).toBeNull()
    expect(parseRemoteMachineSnapshots([{ name: 'no key' }])).toEqual([])
  })
})
