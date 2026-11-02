import { describe, expect, it } from 'vitest'
import { buildHostHeaderMenuModel } from './host-header-menu-items'

describe('buildHostHeaderMenuModel', () => {
  it('leads with Re-pair for a runtime host that revoked this client', () => {
    const model = buildHostHeaderMenuModel({
      kind: 'runtime',
      health: 'blocked',
      blockedReason: 'access-revoked'
    })
    expect(model.actions).toEqual([
      'runtime-repair',
      'rename',
      'runtime-check-connection',
      'manage',
      'remove'
    ])
    expect(model.blocked).toBeNull()
  })

  it('offers Re-pair only for an access-revoked runtime host', () => {
    expect(
      buildHostHeaderMenuModel({
        kind: 'runtime',
        health: 'blocked',
        blockedReason: 'incompatible'
      }).actions
    ).not.toContain('runtime-repair')
    expect(
      buildHostHeaderMenuModel({
        kind: 'runtime',
        health: 'available',
        blockedReason: 'access-revoked'
      }).actions
    ).not.toContain('runtime-repair')
    expect(
      buildHostHeaderMenuModel({
        kind: 'ssh',
        health: 'blocked',
        blockedReason: 'access-revoked'
      }).actions
    ).not.toContain('runtime-repair')
  })

  it('offers Check connection, not an access link, for a server Orca pairs over SSH', () => {
    const actions = buildHostHeaderMenuModel({
      kind: 'runtime',
      health: 'blocked',
      blockedReason: 'access-revoked',
      repairableWithAccessLink: false
    }).actions
    expect(actions).not.toContain('runtime-repair')
    expect(actions).toContain('runtime-check-connection')
  })

  it('leads with Start for a WSL host whose distro is stopped, and only then', () => {
    expect(
      buildHostHeaderMenuModel({
        kind: 'runtime',
        health: 'available',
        wslDistroStopped: true
      }).actions
    ).toEqual(['wsl-start', 'rename', 'runtime-check-connection', 'manage', 'remove'])
    expect(
      buildHostHeaderMenuModel({ kind: 'runtime', health: 'available' }).actions
    ).not.toContain('wsl-start')
    expect(
      buildHostHeaderMenuModel({
        kind: 'ssh',
        health: 'available',
        wslDistroStopped: true
      }).actions
    ).not.toContain('wsl-start')
  })
})
