import { describe, expect, it } from 'vitest'
import { isAllowedPluginGitUrl, pluginInstallSourceSchema } from './plugin-install-lockfile'

describe('pluginInstallSourceSchema marketplace provenance', () => {
  it('records both the marketplace snapshot and plugin Git ref', () => {
    expect(
      pluginInstallSourceSchema.parse({
        kind: 'marketplace',
        marketplace: {
          url: 'https://github.com/stablyai/orca-plugins.git',
          ref: 'main',
          resolvedCommit: 'a'.repeat(40)
        },
        plugin: {
          url: 'git@github.com:stablyai/orca-skills.git',
          ref: 'v1.0.0'
        }
      })
    ).toEqual({
      kind: 'marketplace',
      marketplace: {
        url: 'https://github.com/stablyai/orca-plugins.git',
        ref: 'main',
        resolvedCommit: 'a'.repeat(40)
      },
      plugin: {
        url: 'git@github.com:stablyai/orca-skills.git',
        ref: 'v1.0.0'
      }
    })
  })

  it('requires pinned refs and an exact marketplace snapshot commit', () => {
    expect(
      pluginInstallSourceSchema.safeParse({
        kind: 'marketplace',
        marketplace: {
          url: 'https://github.com/stablyai/orca-plugins.git',
          ref: '',
          resolvedCommit: 'main'
        },
        plugin: {
          url: 'https://github.com/stablyai/orca-skills.git',
          ref: ''
        }
      }).success
    ).toBe(false)
  })
})

describe('isAllowedPluginGitUrl', () => {
  it.each([
    'https://github.com/stablyai/orca-plugins.git',
    'ssh://git@github.com/stablyai/orca-plugins.git',
    'git@github.com:stablyai/orca-plugins.git'
  ])('accepts %s', (url) => {
    expect(isAllowedPluginGitUrl(url)).toBe(true)
  })

  it.each([
    'git@-oProxyCommand=evil:repo.git',
    '-oProxyCommand=evil@github.com:repo.git',
    'ssh://-oProxyCommand=evil/repo.git',
    'ssh://-user@github.com/repo.git',
    'git@github..com:repo.git',
    'https://github..com/repo.git'
  ])('rejects %s', (url) => {
    expect(isAllowedPluginGitUrl(url)).toBe(false)
  })
})
