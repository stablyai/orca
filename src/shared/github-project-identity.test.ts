import { describe, expect, it } from 'vitest'
import { githubProjectHost, githubProjectIdentityKey } from './github-project-identity'

describe('GitHub project identity', () => {
  it('keeps legacy github.com keys while isolating Enterprise hosts and ports', () => {
    const project = { owner: 'Acme', ownerType: 'organization' as const, number: 7 }

    expect(githubProjectIdentityKey(project)).toBe('organization:acme:7')
    expect(githubProjectIdentityKey({ ...project, host: 'github.com' })).toBe('organization:acme:7')
    expect(githubProjectIdentityKey({ ...project, host: ' GitHub.com ' })).toBe(
      'organization:acme:7'
    )
    expect(githubProjectIdentityKey({ ...project, host: 'GHE.EXAMPLE:8443' })).toBe(
      'ghe.example:8443:organization:acme:7'
    )
  })

  it('pins host-less projects to github.com', () => {
    expect(githubProjectHost()).toBe('github.com')
    expect(githubProjectHost('ghe.example:8443')).toBe('ghe.example:8443')
  })
})
