import { describe, expect, it } from 'vitest'
import { parsePluginInstallSource } from './plugin-install-source'

describe('parsePluginInstallSource', () => {
  it('requires an explicit git hash ref', () => {
    expect(parsePluginInstallSource('git', 'https://gitlab.example/acme/plugin')).toEqual({
      ok: false,
      reason: 'missing-git-ref'
    })
    expect(parsePluginInstallSource('git', 'https://gitlab.example/acme/plugin#')).toEqual({
      ok: false,
      reason: 'missing-git-ref'
    })
  })

  it('separates the git URL and ref at the last hash', () => {
    expect(parsePluginInstallSource('git', 'https://example.test/plugin.git#v1.2.3')).toEqual({
      ok: true,
      source: { kind: 'git', url: 'https://example.test/plugin.git', ref: 'v1.2.3' }
    })
  })

  it('accepts HTTPS and SSH git URLs', () => {
    expect(parsePluginInstallSource('git', 'ssh://git@example.test/acme/plugin.git#main')).toEqual({
      ok: true,
      source: { kind: 'git', url: 'ssh://git@example.test/acme/plugin.git', ref: 'main' }
    })
    expect(parsePluginInstallSource('git', 'git@example.test:acme/plugin.git#main')).toEqual({
      ok: true,
      source: { kind: 'git', url: 'git@example.test:acme/plugin.git', ref: 'main' }
    })
  })

  it('rejects executable helpers and embedded HTTPS credentials', () => {
    expect(parsePluginInstallSource('git', 'ext::sh -c touch% /tmp/pwned#main')).toEqual({
      ok: false,
      reason: 'invalid-git-url'
    })
    expect(parsePluginInstallSource('git', 'https://user@example.test/plugin.git#main')).toEqual({
      ok: false,
      reason: 'invalid-git-url'
    })
  })

  it('keeps local paths opaque', () => {
    expect(parsePluginInstallSource('local-path', ' C:\\plugins\\demo ')).toEqual({
      ok: true,
      source: { kind: 'local-path', path: 'C:\\plugins\\demo' }
    })
  })
})
