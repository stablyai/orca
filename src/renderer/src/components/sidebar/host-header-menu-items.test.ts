import { describe, expect, it } from 'vitest'
import { buildHostHeaderMenuModel } from './host-header-menu-items'

describe('buildHostHeaderMenuModel', () => {
  it('offers Focus + Rename + Manage for the local host (no Remove)', () => {
    const model = buildHostHeaderMenuModel({ kind: 'local', health: 'local' })
    expect(model.actions).toEqual(['rename', 'manage'])
    expect(model.actions).not.toContain('remove')
    expect(model.blocked).toBeNull()
  })

  it('offers Reconnect + Remove for a disconnected SSH host', () => {
    const model = buildHostHeaderMenuModel({
      kind: 'ssh',
      health: 'disconnected',
      sshConnected: false
    })
    expect(model.actions).toEqual(['rename', 'ssh-reconnect', 'manage', 'remove'])
  })

  it('offers Disconnect + Remove for a connected SSH host', () => {
    const model = buildHostHeaderMenuModel({
      kind: 'ssh',
      health: 'available',
      sshConnected: true
    })
    expect(model.actions).toEqual(['rename', 'ssh-disconnect', 'manage', 'remove'])
  })

  it('offers Check connection + Remove for a runtime host', () => {
    const model = buildHostHeaderMenuModel({ kind: 'runtime', health: 'available' })
    expect(model.actions).toEqual(['rename', 'runtime-check-connection', 'manage', 'remove'])
  })

  it('offers Rename for every host kind', () => {
    for (const kind of ['local', 'ssh', 'runtime'] as const) {
      expect(buildHostHeaderMenuModel({ kind, health: 'available' }).actions).toContain('rename')
    }
  })

  it('offers Remove only for ssh and runtime hosts', () => {
    expect(buildHostHeaderMenuModel({ kind: 'ssh', health: 'available' }).actions).toContain(
      'remove'
    )
    expect(buildHostHeaderMenuModel({ kind: 'runtime', health: 'available' }).actions).toContain(
      'remove'
    )
    expect(buildHostHeaderMenuModel({ kind: 'local', health: 'local' }).actions).not.toContain(
      'remove'
    )
  })

  it('surfaces a server-too-old block for a blocked runtime host', () => {
    const model = buildHostHeaderMenuModel({
      kind: 'runtime',
      health: 'blocked',
      compatibility: {
        kind: 'blocked',
        reason: 'server-too-old',
        clientProtocolVersion: 5,
        serverProtocolVersion: 1,
        requiredServerProtocolVersion: 4
      }
    })
    expect(model.blocked).toEqual({ reason: 'server-too-old' })
    expect(model.actions).toContain('runtime-check-connection')
  })

  it('surfaces a client-too-old block per verdict reason', () => {
    const model = buildHostHeaderMenuModel({
      kind: 'runtime',
      health: 'blocked',
      compatibility: {
        kind: 'blocked',
        reason: 'client-too-old',
        clientProtocolVersion: 1,
        serverProtocolVersion: 5,
        requiredClientProtocolVersion: 4
      }
    })
    expect(model.blocked).toEqual({ reason: 'client-too-old' })
  })

  it('does not surface a block when health is not blocked', () => {
    const model = buildHostHeaderMenuModel({
      kind: 'runtime',
      health: 'available',
      compatibility: { kind: 'ok', clientProtocolVersion: 5, serverProtocolVersion: 5 }
    })
    expect(model.blocked).toBeNull()
  })
})
