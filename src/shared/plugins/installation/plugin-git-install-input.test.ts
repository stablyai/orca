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
})
