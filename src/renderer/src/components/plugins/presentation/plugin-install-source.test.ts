import { describe, expect, it } from 'vitest'
import { parsePluginInstallSource } from './plugin-install-source'

describe('parsePluginInstallSource', () => {
  it('leaves the version to main when the git input names none', () => {
    expect(parsePluginInstallSource('git', 'kolebayev/orca-md-layout')).toEqual({
      ok: true,
      source: { kind: 'git', url: 'https://github.com/kolebayev/orca-md-layout', ref: '' }
    })
    expect(
      parsePluginInstallSource(
        'git',
        'https://github.com/kolebayev/orca-md-layout/releases/tag/v0.1.0'
      )
    ).toEqual({
      ok: true,
      source: { kind: 'git', url: 'https://github.com/kolebayev/orca-md-layout', ref: 'v0.1.0' }
    })
  })

  it('accepts HTTPS and SSH git URLs with an explicit ref', () => {
    expect(parsePluginInstallSource('git', 'git@example.test:acme/plugin.git#main')).toEqual({
      ok: true,
      source: { kind: 'git', url: 'git@example.test:acme/plugin.git', ref: 'main' }
    })
  })

  it('names why a git URL is refused', () => {
    expect(parsePluginInstallSource('git', 'ext::sh -c touch% /tmp/pwned#main')).toEqual({
      ok: false,
      reason: 'invalid-git-url'
    })
    expect(parsePluginInstallSource('git', 'https://user@example.test/acme/plugin.git')).toEqual({
      ok: false,
      reason: 'git-url-credentials'
    })
    expect(parsePluginInstallSource('local-path', '  ')).toEqual({
      ok: false,
      reason: 'missing-local-path'
    })
  })
})
