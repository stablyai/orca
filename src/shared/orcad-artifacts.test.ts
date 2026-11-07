import { describe, expect, it } from 'vitest'
import {
  ORCAD_ARTIFACTS,
  ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS,
  ORCAD_MOBILE_WEB_MANIFEST,
  orcadArtifactFilenames,
  orcadMobileWebAssetFilenames,
  orcadNodeRuntimeRelativePath,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from './orcad-artifacts'
import { COMPAT_SERVER_TARGETS, SERVER_TARGETS } from './node-runtime-pin'

describe('standalone runtime artifacts', () => {
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

  it('includes the complete Iroh closure only in the Linux x64 glibc target inventory', () => {
    const expected = [
      'node_modules/@number0/iroh/package.json',
      'node_modules/@number0/iroh/index.js',
      'node_modules/@number0/iroh/iroh.linux-x64-gnu.node'
    ]
    expect(ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS).toEqual(expected)
    const irohs = (filenames: readonly string[]) =>
      filenames.filter((filename) => filename.startsWith('node_modules/@number0/iroh/'))
    expect(irohs(orcadArtifactFilenames('linux-x64-glibc', []))).toEqual(expected)
    expect(irohs(orcadTemplateTargetFilenames('linux-x64-glibc'))).toEqual(expected)
    expect(irohs(ORCAD_ARTIFACTS.map((artifact) => artifact.filename))).toEqual([])
    expect(irohs(orcadTemplateCommonFilenames([]))).toEqual([])
    for (const target of [...SERVER_TARGETS, ...COMPAT_SERVER_TARGETS]) {
      if (target !== 'linux-x64-glibc') {
        expect(irohs(orcadArtifactFilenames(target, []))).toEqual([])
        expect(irohs(orcadTemplateTargetFilenames(target))).toEqual([])
      }
    }
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
