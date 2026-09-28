import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_RIPGREP_PLATFORMS, bundledRipgrepBinaryName } from './bundled-ripgrep'
import {
  ORCAD_ARTIFACTS,
  ORCAD_WINDOWS_CONPTY_ARTIFACTS,
  ORCAD_RIPGREP_ARTIFACTS,
  ORCAD_RIPGREP_LICENSE_ARTIFACTS,
  orcadArtifactFilenames
} from './orcad-artifacts'

describe('standalone runtime artifacts', () => {
  it.each(['win32', 'win32-x64', 'win32-arm64'])(
    'requires the full ConPTY closure on %s',
    (target) => {
      expect(orcadArtifactFilenames(target)).toEqual(
        expect.arrayContaining([...ORCAD_WINDOWS_CONPTY_ARTIFACTS])
      )
    }
  )

  it.each(['', 'linux-x64-glibc', 'linux-arm64-musl', 'darwin-arm64'])(
    'preserves the POSIX artifact sequence for %s',
    (target) => {
      expect(orcadArtifactFilenames(target)).toEqual(
        ORCAD_ARTIFACTS.filter((artifact) => !artifact.optional).map(
          (artifact) => artifact.filename
        )
      )
    }
  )

  it('ships search binaries for every SSH host and includes them in the install identity', () => {
    const expected = BUNDLED_RIPGREP_PLATFORMS.map(
      (platform) => `ripgrep/${platform}/${bundledRipgrepBinaryName(platform)}`
    )
    expect(ORCAD_RIPGREP_ARTIFACTS).toEqual(expected)
    expect(orcadArtifactFilenames()).toEqual(expect.arrayContaining(expected))
  })

  it('ships the binary redistribution notices with every install', () => {
    const sourceDir = join(__dirname, '../../resources/licenses/ripgrep')
    expect(ORCAD_RIPGREP_LICENSE_ARTIFACTS.map((path) => path.split('/').at(-1)).sort()).toEqual(
      readdirSync(sourceDir).sort()
    )
    expect(orcadArtifactFilenames()).toEqual(
      expect.arrayContaining([...ORCAD_RIPGREP_LICENSE_ARTIFACTS])
    )
  })
})
