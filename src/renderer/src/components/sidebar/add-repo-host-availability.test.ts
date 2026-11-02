import { describe, expect, it } from 'vitest'
import { canConnectAddRepoHost, canSelectAddRepoHost } from './add-repo-host-availability'

describe('Add Project host availability', () => {
  it('keeps a reachable runtime selectable while shared control reconnects', () => {
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'available' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'connecting' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'disconnected' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'error' })).toBe(false)
  })

  it('honors a blocked compatibility verdict even while shared control connects', () => {
    expect(
      canSelectAddRepoHost({
        kind: 'runtime',
        health: 'connecting',
        compatibility: {
          kind: 'blocked',
          reason: 'server-too-old',
          clientProtocolVersion: 3,
          serverProtocolVersion: 1,
          requiredServerProtocolVersion: 2
        }
      })
    ).toBe(false)
  })

  it('requires a managed server after SSH connects', () => {
    expect(canConnectAddRepoHost({ kind: 'ssh', health: 'connecting' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'ssh', health: 'connecting' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'ssh', health: 'available' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'local', health: 'local' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'local', health: 'connecting' })).toBe(false)
  })

  it('preserves explicit WSL startup and unavailable-host restrictions', () => {
    const host = { kind: 'runtime', health: 'disconnected', wslDistro: 'Ubuntu' } as const

    expect(canSelectAddRepoHost(host)).toBe(false)
    expect(canConnectAddRepoHost(host)).toBe(true)
    expect(canConnectAddRepoHost({ ...host, wslUnavailable: 'turned-off' })).toBe(false)
    expect(canConnectAddRepoHost({ ...host, wslUnavailable: 'server-files-missing' })).toBe(false)
  })
})
