import { SERVER_TARGETS } from './node-runtime-pin'
import { describe, expect, it } from 'vitest'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_WINDOWS_GUEST_TREE_KILL_ARTIFACTS,
  ORCAD_WINDOWS_PROCESS_TREE_FILENAME,
  ORCAD_WINDOWS_SECURITY_FILENAME,
  ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME,
  orcadArtifactFilenames,
  orcadTemplateTargetFilenames,
  orcadTemplateCommonFilenames,
  orcadMobileWebAssetFilenames,
  orcadNodeRuntimeRelativePath
} from './orcad-artifacts'

describe('standalone runtime artifacts', () => {
  it.each(SERVER_TARGETS)('keeps guest cleanup artifacts in the correct %s slot', (target) => {
    const expected = target.startsWith('win32-') ? [...ORCAD_WINDOWS_GUEST_TREE_KILL_ARTIFACTS] : []
    const guestArtifacts = (filenames: string[]): string[] =>
      filenames.filter((filename) => filename.startsWith('guest-tree-kill/'))

    expect(guestArtifacts(orcadArtifactFilenames(target, []))).toEqual(expected)
    expect(guestArtifacts(orcadTemplateTargetFilenames(target))).toEqual(expected)
    expect(guestArtifacts(orcadTemplateCommonFilenames([]))).toEqual([])
  })

  it.each(['win32-x64', 'win32-arm64'])(
    'keeps all Windows addons and guest cleanup together in the %s slot',
    (target) => {
      const required = [
        ORCAD_WINDOWS_PROCESS_TREE_FILENAME,
        ORCAD_WINDOWS_SECURITY_FILENAME,
        ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME,
        ...ORCAD_WINDOWS_GUEST_TREE_KILL_ARTIFACTS
      ]
      for (const filenames of [
        orcadArtifactFilenames(target, []),
        orcadTemplateTargetFilenames(target)
      ]) {
        expect(filenames).toEqual(expect.arrayContaining(required))
        expect(new Set(filenames).size).toBe(filenames.length)
      }
      for (const filename of required) {
        expect(orcadTemplateCommonFilenames([])).not.toContain(filename)
      }
    }
  )

  it('keeps the runtime executable under its upstream name in the shared store', () => {
    expect(orcadNodeRuntimeRelativePath('linux-x64-glibc', 'a'.repeat(64))).toEqual([
      '..',
      'runtimes',
      `node-${'a'.repeat(64)}`,
      'bin',
      'node'
    ])
    expect(orcadNodeRuntimeRelativePath('win32-x64', 'b'.repeat(64)).at(-1)).toBe('node.exe')
  })

  it('names the page assets its manifest lists, in a locale-free order', () => {
    const manifest = JSON.stringify({
      assets: [{ path: 'index.html' }, { path: 'assets/b.js' }, { path: 'assets/B.css' }]
    })
    expect(orcadMobileWebAssetFilenames(manifest)).toEqual([
      'out/mobile-web/assets/B.css',
      'out/mobile-web/assets/b.js',
      'out/mobile-web/index.html'
    ])
  })

  it.each([
    ['no assets', { assets: [] }],
    ['a traversal path', { assets: [{ path: '../orcad.js' }] }],
    ['an absolute path', { assets: [{ path: '/etc/passwd' }] }],
    ['a backslash path', { assets: [{ path: 'a\\b.js' }] }],
    ['a missing path', { assets: [{}] }]
  ])('refuses a page manifest with %s', (_label, manifest) => {
    expect(() => orcadMobileWebAssetFilenames(JSON.stringify(manifest))).toThrow(
      ORCAD_MOBILE_WEB_MANIFEST
    )
  })
})
