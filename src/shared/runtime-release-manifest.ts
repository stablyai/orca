// Why: shared, dependency-free release-metadata lookup for the remote server
// update advisor. Maps the SERVER's platform/arch to the electron-updater
// manifest the desktop updater already publishes (`latest-*.yml`), parses the
// few fields the advisor needs out of that YAML, and derives latestVersion /
// updateAvailable / exact package asset URLs. No Electron/Node imports: the
// network fetch lives in main (renderer `fetch()` would hit CORS on GitHub's
// release-asset redirect), while parsing stays here so it is unit-testable from
// fixture text and the mobile client can mirror it. The manifests are
// machine-generated and regular, so the needed fields are parsed by hand rather
// than pulling a YAML dependency into a shared/mobile-mirrored module.

import type { RuntimeInstallKind } from './runtime-types'
import {
  ORCA_LATEST_DOWNLOAD_BASE_URL,
  type RuntimeUpdateGuideArch
} from './runtime-update-guide-templates'

export const RELEASE_MANIFEST_BASE_URL = ORCA_LATEST_DOWNLOAD_BASE_URL

export type ParsedReleaseManifest = {
  version?: string
  files: string[]
}

export type ReleaseMetadata = {
  latestVersion?: string
  updateAvailable?: boolean
  assetUrl?: string
}

// electron-updater publishes one manifest per platform, with a separate arm64
// Linux variant. Returns null for platforms with no published manifest so the
// caller skips the fetch entirely.
export function manifestFilenameForHost(
  platform: string | undefined,
  arch: RuntimeUpdateGuideArch | undefined
): string | null {
  switch (platform) {
    case 'linux':
      // Arch unknown → default to the x64 manifest, mirroring the guide's
      // "show x64, note arm64" fallback rather than guessing arm64.
      return arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'
    case 'darwin':
      return 'latest-mac.yml'
    case 'win32':
      return 'latest.yml'
    default:
      return null
  }
}

export function buildReleaseManifestUrl(
  platform: string | undefined,
  arch: RuntimeUpdateGuideArch | undefined
): string | null {
  const filename = manifestFilenameForHost(platform, arch)
  return filename ? `${RELEASE_MANIFEST_BASE_URL}/${filename}` : null
}

// A published tag can briefly appear before its assets are reachable; only a
// well-formed semver is displayed or compared, so a partial/garbage manifest
// degrades to version-less guidance instead of rendering junk.
const MANIFEST_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]{1,40})?$/
// The asset filename is rendered into a copyable `curl`/`install` command, so
// restrict it to the characters electron-builder emits for package artifacts.
const PACKAGE_ASSET_NAME_PATTERN = /^[A-Za-z0-9._+-]+\.(?:deb|rpm)$/

const stripYamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

const basename = (value: string): string => {
  const withoutQuery = value.split(/[?#]/)[0]
  const segments = withoutQuery.split('/')
  return segments.at(-1) || withoutQuery
}

// Top-level `version:` (no indent) and each file entry's `url:`. electron-updater
// manifests carry no other `url:` key, so collecting every indented `url:` line
// yields the file list without a full YAML parse.
const TOP_LEVEL_VERSION_LINE = /^version:\s*(.+?)\s*$/
const FILE_URL_LINE = /^\s+-?\s*url:\s*(.+?)\s*$/

export function parseReleaseManifest(yamlText: string): ParsedReleaseManifest | null {
  if (typeof yamlText !== 'string' || yamlText.length === 0) {
    return null
  }
  let version: string | undefined
  const files: string[] = []
  for (const line of yamlText.split(/\r?\n/)) {
    if (version === undefined) {
      const versionMatch = line.match(TOP_LEVEL_VERSION_LINE)
      if (versionMatch) {
        const candidate = stripYamlScalar(versionMatch[1])
        version = MANIFEST_VERSION_PATTERN.test(candidate) ? candidate : undefined
        continue
      }
    }
    const urlMatch = line.match(FILE_URL_LINE)
    if (urlMatch) {
      const url = stripYamlScalar(urlMatch[1])
      if (url) {
        files.push(url)
      }
    }
  }
  if (version === undefined && files.length === 0) {
    return null
  }
  return { version, files }
}

const packageExtension = (installKind: RuntimeInstallKind | undefined): 'deb' | 'rpm' | null => {
  if (installKind === 'linux-deb') {
    return 'deb'
  }
  if (installKind === 'linux-rpm') {
    return 'rpm'
  }
  return null
}

// electron-builder names deb assets `_amd64.deb`/`_arm64.deb` and rpm assets
// `.x86_64.rpm`/`.aarch64.rpm`; require the arch token when the arch is known so
// an x64 command is never handed to an arm64 server.
const archTokens = (
  ext: 'deb' | 'rpm',
  arch: RuntimeUpdateGuideArch | undefined
): string[] | null => {
  if (!arch) {
    return null
  }
  if (ext === 'deb') {
    return arch === 'arm64' ? ['arm64'] : ['amd64']
  }
  return arch === 'arm64' ? ['aarch64'] : ['x86_64']
}

// Only if the manifest actually enumerates a matching package asset. In
// practice `latest-linux.yml` lists only the AppImage, so deb/rpm keep the
// manual releases-page guidance — this returns undefined and the guide falls
// back gracefully.
export function selectPackageAssetUrl(
  files: readonly string[],
  installKind: RuntimeInstallKind | undefined,
  arch: RuntimeUpdateGuideArch | undefined
): string | undefined {
  const ext = packageExtension(installKind)
  if (!ext) {
    return undefined
  }
  const tokens = archTokens(ext, arch)
  const match = files
    .map((file) => basename(file))
    .find((name) => {
      if (!PACKAGE_ASSET_NAME_PATTERN.test(name) || !name.toLowerCase().endsWith(`.${ext}`)) {
        return false
      }
      return tokens === null || tokens.some((token) => name.includes(token))
    })
  return match ? `${RELEASE_MANIFEST_BASE_URL}/${match}` : undefined
}

export function deriveReleaseMetadata(args: {
  manifest: ParsedReleaseManifest
  currentVersion?: string
  installKind?: RuntimeInstallKind
  arch?: RuntimeUpdateGuideArch
}): ReleaseMetadata {
  const { manifest, currentVersion, installKind, arch } = args
  const metadata: ReleaseMetadata = {}
  if (manifest.version) {
    metadata.latestVersion = manifest.version
    // updateAvailable only when both versions are known; a mismatch means the
    // server is not on the latest build, absent means we can't say.
    if (currentVersion) {
      metadata.updateAvailable = manifest.version !== currentVersion
    }
  }
  const assetUrl = selectPackageAssetUrl(manifest.files, installKind, arch)
  if (assetUrl) {
    metadata.assetUrl = assetUrl
  }
  return metadata
}
