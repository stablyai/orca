import { describe, expect, it } from 'vitest'
import { resolveAccountOwner, wslHostDistroForTarget } from './wsl-host-account-owner'

const ENVIRONMENTS = [
  {
    id: 'wsl:Ubuntu',
    orcadDeployment: {
      kind: 'wsl' as const,
      distro: 'Ubuntu',
      localPort: 41000,
      remotePort: 41001
    }
  },
  { id: 'server-1', orcadDeployment: undefined }
]

describe('resolveAccountOwner', () => {
  it('makes this desktop the owner of a WSL host, for its distro', () => {
    expect(
      resolveAccountOwner({ kind: 'environment', environmentId: 'wsl:Ubuntu' }, ENVIRONMENTS)
    ).toEqual({ target: { kind: 'local' }, wslHostDistro: 'Ubuntu' })
  })

  it('keeps a paired server as the owner of its own accounts', () => {
    const target = { kind: 'environment' as const, environmentId: 'server-1' }
    expect(resolveAccountOwner(target, ENVIRONMENTS)).toEqual({
      target,
      wslHostDistro: null
    })
  })

  it('never guesses a WSL host from an id that is not in the catalog', () => {
    expect(
      wslHostDistroForTarget({ kind: 'environment', environmentId: 'wsl:Debian' }, ENVIRONMENTS)
    ).toBeNull()
    expect(wslHostDistroForTarget({ kind: 'local' }, ENVIRONMENTS)).toBeNull()
  })
})
