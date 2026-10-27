import { describe, expect, it } from 'vitest'
import { pluginInstallSourceSchema } from './plugin-install-lockfile'

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
    const source = {
      kind: 'marketplace',
      marketplace: {
        url: 'https://github.com/stablyai/orca-plugins.git',
        ref: 'main',
        resolvedCommit: 'a'.repeat(40)
      },
      plugin: {
        url: 'https://github.com/stablyai/orca-skills.git',
        ref: 'v1.0.0'
      }
    }

    expect(
      pluginInstallSourceSchema.safeParse({
        ...source,
        marketplace: { ...source.marketplace, ref: '' }
      }).success
    ).toBe(false)
    expect(
      pluginInstallSourceSchema.safeParse({
        ...source,
        marketplace: { ...source.marketplace, resolvedCommit: 'main' }
      }).success
    ).toBe(false)
    expect(
      pluginInstallSourceSchema.safeParse({
        ...source,
        plugin: { ...source.plugin, ref: '' }
      }).success
    ).toBe(false)
  })
})
