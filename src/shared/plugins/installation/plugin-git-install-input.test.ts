import { describe, expect, it } from 'vitest'
import { isSafePluginGitRef, parsePluginGitInstallInput } from './plugin-git-install-input'

const REPO = 'https://github.com/kolebayev/orca-md-layout'

describe('parsePluginGitInstallInput', () => {
  it.each([
    [REPO, REPO, ''],
    [`${REPO}/`, REPO, ''],
    [`${REPO}.git`, `${REPO}.git`, ''],
    ['kolebayev/orca-md-layout', REPO, ''],
    ['github.com/kolebayev/orca-md-layout', REPO, ''],
    [`${REPO}#v0.1.0`, REPO, 'v0.1.0'],
    [`${REPO}/releases/tag/v0.1.0`, REPO, 'v0.1.0'],
    [`${REPO}/releases/latest`, REPO, ''],
    [`${REPO}/releases`, REPO, ''],
    [`${REPO}/tags`, REPO, ''],
    [`${REPO}/tree/main`, REPO, 'main'],
    [`${REPO}/tree/feature/narrow`, REPO, 'feature/narrow'],
    [`${REPO}/commit/${'a'.repeat(40)}`, REPO, 'a'.repeat(40)],
    [`${REPO}?tab=readme-ov-file`, REPO, ''],
    [`${REPO}/releases/tag/v1.0.0%2Bbuild`, REPO, 'v1.0.0+build'],
    // Why the page ref wins: GitHub anchors such as #readme are not versions.
    [`${REPO}/tree/v2#readme`, REPO, 'v2'],
    [
      'https://gitlab.com/acme/tools/notes/-/tree/v1.2.0',
      'https://gitlab.com/acme/tools/notes',
      'v1.2.0'
    ],
    ['https://gitlab.com/acme/notes/-/tags/v1.2.0', 'https://gitlab.com/acme/notes', 'v1.2.0'],
    ['https://gitlab.com/acme/notes/-/releases/v1.2.0', 'https://gitlab.com/acme/notes', 'v1.2.0'],
    ['https://gitlab.com/acme/tools/notes', 'https://gitlab.com/acme/tools/notes', ''],
    [
      'git@github.com:kolebayev/orca-md-layout.git',
      'git@github.com:kolebayev/orca-md-layout.git',
      ''
    ],
    ['git@github.com:acme/notes.git#v1', 'git@github.com:acme/notes.git', 'v1'],
    [
      'ssh://git@example.test/acme/plugin.git#main',
      'ssh://git@example.test/acme/plugin.git',
      'main'
    ]
  ])('reads %s', (input, url, ref) => {
    expect(parsePluginGitInstallInput(`  ${input}  `)).toEqual({ ok: true, url, ref })
  })

  it.each([
    ['', 'missing-git-url'],
    ['#v1', 'missing-git-url'],
    ['https://user:token@github.com/acme/notes', 'git-url-credentials'],
    ['https://token@github.com/acme/notes', 'git-url-credentials'],
    ['ssh://git:secret@example.test/acme/notes.git', 'git-url-credentials'],
    ['http://github.com/acme/notes', 'invalid-git-url'],
    ['file:///tmp/plugin', 'invalid-git-url'],
    ['ext::sh -c touch% /tmp/pwned#main', 'invalid-git-url'],
    ['-oProxyCommand=calc@host:repo', 'invalid-git-url'],
    ['ssh://-oProxyCommand=calc/repo', 'invalid-git-url'],
    ['https://github.com/acme', 'invalid-git-url'],
    ['notes', 'invalid-git-url'],
    [`${REPO}#--upload-pack=calc`, 'invalid-git-ref'],
    [`${REPO}#../../main`, 'invalid-git-ref'],
    [`${REPO}/tree/a..b`, 'invalid-git-ref'],
    [`${REPO}/tree/%ZZ`, 'invalid-git-ref']
  ])('refuses %s', (input, reason) => {
    expect(parsePluginGitInstallInput(input)).toEqual({ ok: false, reason })
  })
})

describe('isSafePluginGitRef', () => {
  it('follows Git ref rules and never reads as an option', () => {
    for (const ref of ['v0.1.0', 'release/1.x', 'a'.repeat(40), 'v1.0.0+build']) {
      expect(isSafePluginGitRef(ref)).toBe(true)
    }
    for (const ref of [
      '',
      '-x',
      'a..b',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'x.lock',
      '.hidden',
      'a//b',
      '@',
      'a@{1}',
      'tab\t'
    ]) {
      expect(isSafePluginGitRef(ref)).toBe(false)
    }
  })
})
