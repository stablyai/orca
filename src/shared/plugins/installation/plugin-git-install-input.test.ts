import { describe, expect, it } from 'vitest'
import { parsePluginGitInstallInput } from './plugin-git-install-input'

describe('parsePluginGitInstallInput', () => {
  it('reads Codeberg tag and commit pages as a repository and ref', () => {
    expect(parsePluginGitInstallInput('https://codeberg.org/o/r/src/tag/v1.2.0')).toEqual({
      ok: true,
      url: 'https://codeberg.org/o/r',
      ref: 'v1.2.0'
    })
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(
      parsePluginGitInstallInput(`https://codeberg.org/o/r/src/commit/${sha}/README.md`)
    ).toEqual({
      ok: true,
      url: 'https://codeberg.org/o/r',
      ref: sha
    })
  })

  it('preserves Bitbucket source paths as repository URLs', () => {
    expect(parsePluginGitInstallInput('https://bitbucket.org/o/r/src/branch/README.md')).toEqual({
      ok: true,
      url: 'https://bitbucket.org/o/r/src/branch/README.md',
      ref: ''
    })
  })

  it('keeps a `-` segment inside a GitHub ref', () => {
    expect(parsePluginGitInstallInput('https://github.com/o/r/tree/feature/-/example')).toEqual({
      ok: true,
      url: 'https://github.com/o/r',
      ref: 'feature/-/example'
    })
    expect(parsePluginGitInstallInput('https://github.com/o/r/tree/-/foo')).toEqual({
      ok: false,
      reason: 'invalid-git-ref'
    })
  })

  it('keeps a `-` ref segment on Codeberg and www hosts', () => {
    expect(
      parsePluginGitInstallInput('https://codeberg.org/o/r/src/branch/feature/-/example')
    ).toEqual({ ok: true, url: 'https://codeberg.org/o/r', ref: 'feature/-/example' })
    expect(parsePluginGitInstallInput('https://www.github.com/o/r/tree/x/-/tree/y')).toEqual({
      ok: true,
      url: 'https://www.github.com/o/r',
      ref: 'x/-/tree/y'
    })
  })

  it('reads a GitHub blob page as the repository, like GitLab', () => {
    expect(parsePluginGitInstallInput('https://github.com/o/r/blob/main/README.md')).toEqual({
      ok: true,
      url: 'https://github.com/o/r',
      ref: ''
    })
    expect(parsePluginGitInstallInput('https://github.com/o/r/blob/main/sub/dir/file.md')).toEqual({
      ok: true,
      url: 'https://github.com/o/r',
      ref: ''
    })
  })

  it('reads a GitLab subgroup project named like a page kind', () => {
    expect(parsePluginGitInstallInput('https://gitlab.com/g/sub/releases/-/tree/main')).toEqual({
      ok: true,
      url: 'https://gitlab.com/g/sub/releases',
      ref: 'main'
    })
    expect(
      parsePluginGitInstallInput('https://gitlab.com/g/sub/tree/-/blob/main/README.md')
    ).toEqual({
      ok: true,
      url: 'https://gitlab.com/g/sub/tree',
      ref: ''
    })
    expect(
      parsePluginGitInstallInput('https://gitlab.example.com/g/sub/tree/p/-/blob/main/README.md')
    ).toEqual({ ok: true, url: 'https://gitlab.example.com/g/sub/tree/p', ref: '' })
    expect(
      parsePluginGitInstallInput('https://gitlab.com/g/sub/src/branch/p/-/graphs/main')
    ).toEqual({ ok: true, url: 'https://gitlab.com/g/sub/src/branch/p', ref: '' })
  })
})
