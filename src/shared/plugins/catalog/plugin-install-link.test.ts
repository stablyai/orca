import { describe, expect, it } from 'vitest'
import {
  COMMUNITY_MARKETPLACE_GIT_SOURCE,
  parsePluginInstallLink,
  pluginInstallLinkFromArguments,
  PLUGIN_INSTALL_LINK_MAX_LENGTH
} from './plugin-install-link'

describe('parsePluginInstallLink', () => {
  it('defaults to the official catalog', () => {
    expect(parsePluginInstallLink('orca://plugins/acme.dusk')).toEqual({
      pluginKey: 'acme.dusk',
      catalog: { kind: 'official' }
    })
    expect(parsePluginInstallLink('orca://plugins/acme.dusk/?catalog=official')?.catalog).toEqual({
      kind: 'official'
    })
  })

  it('maps the community alias and the official URL', () => {
    expect(parsePluginInstallLink('orca://plugins/acme.dusk?catalog=community')?.catalog).toEqual({
      kind: 'community',
      source: COMMUNITY_MARKETPLACE_GIT_SOURCE
    })
    const official = encodeURIComponent('https://github.com/stablyai/orca-plugins.git')
    expect(parsePluginInstallLink(`orca://plugins/acme.dusk?catalog=${official}`)?.catalog).toEqual(
      { kind: 'official' }
    )
  })

  it.each([
    'https://gitlab.com/acme/tools/catalog.git',
    'ssh://git@github.com/acme/catalog.git',
    'git@github.com:acme/catalog.git'
  ])('accepts the catalog URL %s at main', (catalogUrl) => {
    expect(
      parsePluginInstallLink(`orca://plugins/acme.dusk?catalog=${encodeURIComponent(catalogUrl)}`)
    ).toEqual({
      pluginKey: 'acme.dusk',
      catalog: { kind: 'url', source: { kind: 'git', url: catalogUrl, ref: 'main' } }
    })
  })

  it.each([
    ['no id', 'orca://plugins/'],
    ['unqualified id', 'orca://plugins/dusk'],
    ['bad charset', 'orca://plugins/Acme.Dusk'],
    ['path traversal', 'orca://plugins/acme.dusk/../x'],
    ['prototype name', 'orca://plugins/acme.constructor'],
    ['another host', 'orca://pluginsx/acme.dusk'],
    ['extra parameter', 'orca://plugins/acme.dusk?catalog=official&install=1'],
    ['repeated catalog', 'orca://plugins/acme.dusk?catalog=official&catalog=community'],
    ['fragment', 'orca://plugins/acme.dusk#x'],
    [
      'http catalog',
      `orca://plugins/acme.dusk?catalog=${encodeURIComponent('http://example.com/c.git')}`
    ],
    ['file catalog', `orca://plugins/acme.dusk?catalog=${encodeURIComponent('file:///tmp/c')}`],
    [
      'credentials in catalog',
      `orca://plugins/acme.dusk?catalog=${encodeURIComponent('https://user:token@github.com/acme/c.git')}`
    ],
    [
      'long catalog',
      `orca://plugins/acme.dusk?catalog=https://github.com/acme/${'a'.repeat(520)}.git`
    ],
    ['reserved publisher elsewhere', 'orca://plugins/stablyai.orca-skills?catalog=community'],
    ['not a plugin link', 'orca://skills/share/abc']
  ])('rejects %s', (_label, value) => {
    expect(parsePluginInstallLink(value)).toBeNull()
  })

  it('accepts a reserved publisher only from the official catalog', () => {
    expect(parsePluginInstallLink('orca://plugins/stablyai.orca-skills')?.pluginKey).toBe(
      'stablyai.orca-skills'
    )
  })

  it('rejects an oversized link instead of trimming it valid', () => {
    const long = `orca://plugins/acme.dusk?catalog=official${'x'.repeat(PLUGIN_INSTALL_LINK_MAX_LENGTH)}`
    const captured = pluginInstallLinkFromArguments([long])
    expect(captured?.length).toBe(PLUGIN_INSTALL_LINK_MAX_LENGTH + 1)
    expect(parsePluginInstallLink(captured!)).toBeNull()
  })
})

describe('pluginInstallLinkFromArguments', () => {
  it('finds the link in Windows and Linux second-instance argv', () => {
    expect(
      pluginInstallLinkFromArguments([
        'C:\\Program Files\\Orca\\Orca.exe',
        '--allow-file-access-from-files',
        'ORCA://plugins/acme.dusk?catalog=community'
      ])
    ).toBe('ORCA://plugins/acme.dusk?catalog=community')
    expect(pluginInstallLinkFromArguments(['/usr/bin/orca', '/tmp/notes.md'])).toBeNull()
  })
})
