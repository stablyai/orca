import { describe, expect, it } from 'vitest'
import { parseAppWslPtyId, toAppWslPtyId, toRelayWslPtyId } from './wsl-pty-id'
import { parseAppSshPtyId } from './ssh-pty-id'

const owner = { distro: 'Ubuntu @ home', relayBuildId: '0.1.0+abc' }

describe('WSL terminal owner identity', () => {
  it('round trips distro, exact build and opaque guest terminal without an SSH identity', () => {
    const id = toAppWslPtyId(owner, 'pty2:epoch:1')
    expect(parseAppWslPtyId(id)).toEqual({ ...owner, relayPtyId: 'pty2:epoch:1' })
    expect(toRelayWslPtyId(owner, id)).toBe('pty2:epoch:1')
    expect(toAppWslPtyId(owner, id)).toBe(id)
    expect(parseAppSshPtyId(id)).toBeNull()
  })

  it('fences both a different distro and a replaced relay build', () => {
    const id = toAppWslPtyId(owner, 'pty2:epoch:1')
    for (const other of [
      { ...owner, distro: 'Debian' },
      { ...owner, relayBuildId: 'new-build' }
    ]) {
      expect(() => toRelayWslPtyId(other, id)).toThrow('different distro or relay build')
      expect(() => toAppWslPtyId(other, id)).toThrow('different distro or relay build')
    }
  })

  it.each([
    'daemon:legacy',
    'ssh:host@@pty-1',
    'wsl:broken',
    'wsl:%XX@@build@@id',
    'wsl:Ubuntu@@build@@'
  ])('never interprets foreign or malformed IDs as guest-owned: %s', (id) => {
    expect(parseAppWslPtyId(id)).toBeNull()
    expect(() => toRelayWslPtyId(owner, id)).toThrow()
  })

  it('encodes separators inside owner names rather than changing the owner', () => {
    const special = { distro: 'Ubuntu@@other', relayBuildId: 'build@@other' }
    expect(parseAppWslPtyId(toAppWslPtyId(special, 'pty@@opaque'))).toEqual({
      ...special,
      relayPtyId: 'pty@@opaque'
    })
  })
})
