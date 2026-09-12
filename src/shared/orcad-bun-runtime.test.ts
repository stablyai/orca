import { describe, expect, it } from 'vitest'
import {
  orcadArtifactFilenames,
  orcadArtifactHashPrefix,
  orcadBunRuntimeFilename
} from './orcad-artifacts'
import { relayBunRuntimeFilename, relayOptionalArtifactFilenames } from './relay-artifacts'
import {
  ORCAD_BUN_RELEASE_ASSETS,
  ORCAD_BUN_VERSION,
  orcadBunReleaseUrl,
  type OrcadBunTarget
} from './orcad-bun-runtime'

const EXPECTED_TARGETS: OrcadBunTarget[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-glibc',
  'linux-x64-glibc',
  'linux-arm64-musl',
  'linux-x64-musl',
  'win32-arm64',
  'win32-x64'
]

describe('orcad Bun runtime catalog', () => {
  it.each(['win32-x64', 'win32-arm64'] as const)('ships executable filenames for %s', (target) => {
    expect(orcadBunRuntimeFilename(target)).toBe('bun-runtime.exe')
    expect(relayBunRuntimeFilename(target)).toBe('bun-runtime.exe')
    expect(orcadArtifactFilenames(target)).toContain('bun-runtime.exe')
    expect(relayOptionalArtifactFilenames(target)).toContain('bun-runtime.exe')
    expect(relayOptionalArtifactFilenames(target)).not.toContain('bun-runtime')
    expect(orcadArtifactHashPrefix(target)).not.toBe('')
  })

  it('preserves POSIX runtime names and content identities', () => {
    expect(orcadBunRuntimeFilename('linux-x64-glibc')).toBe('bun-runtime')
    expect(orcadBunRuntimeFilename('darwin-arm64')).toBe('bun-runtime')
    expect(relayBunRuntimeFilename('linux-x64-glibc')).toBe('bun-runtime-glibc')
    expect(relayBunRuntimeFilename('linux-arm64-musl')).toBe('bun-runtime-musl')
    expect(relayBunRuntimeFilename('darwin-arm64')).toBe('bun-runtime')
    expect(orcadArtifactHashPrefix('linux-x64-glibc')).toBe('')
  })
  it('pins every supported target to a SHA-256-verified release asset', () => {
    expect(Object.keys(ORCAD_BUN_RELEASE_ASSETS).sort()).toEqual(EXPECTED_TARGETS.sort())
    for (const asset of Object.values(ORCAD_BUN_RELEASE_ASSETS)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.executableSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(orcadBunReleaseUrl(asset)).toBe(
        `https://github.com/oven-sh/bun/releases/download/bun-v${ORCAD_BUN_VERSION}/${asset.filename}`
      )
    }
  })
})
