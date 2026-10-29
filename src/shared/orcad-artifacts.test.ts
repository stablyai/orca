import { describe, expect, it } from 'vitest'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  orcadMobileWebAssetFilenames,
  orcadNodeRuntimeRelativePath
} from './orcad-artifacts'

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
