import { describe, expect, it } from 'vitest'
import { pluginInstallTrustee } from './plugin-repository-link'

const MIRROR_URL = 'https://github.com/stablyai/orca-community-mirror.git'

describe('pluginInstallTrustee', () => {
  it('names the publisher of a community plugin mirrored in Orca’s organization (#50922)', () => {
    expect(
      pluginInstallTrustee({
        url: MIRROR_URL,
        publisher: 'harsh97',
        catalogUrl: 'https://github.com/stablyai/orca-community-plugins.git'
      })
    ).toBe('harsh97')
  })

  it('names the repository owner for an Orca repository listed by any other catalog', () => {
    expect(
      pluginInstallTrustee({
        url: MIRROR_URL,
        publisher: 'harsh97',
        catalogUrl: 'https://github.com/mallory/orca-catalog.git'
      })
    ).toBe('stablyai')
  })

  it('names the repository owner elsewhere, whatever publisher a catalog claims', () => {
    expect(
      pluginInstallTrustee({
        url: 'git@github.com:mallory/plugin.git',
        publisher: 'harsh97',
        catalogUrl: 'https://github.com/stablyai/orca-community-plugins.git'
      })
    ).toBe('mallory')
  })
})
