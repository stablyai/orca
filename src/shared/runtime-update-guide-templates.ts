// Why: client-owned command and label templates for the remote server update
// advisor. The trust model requires every copyable command to come from a
// template here; server-supplied data may only select a template or fill a
// pre-validated placeholder, never flow in as free text. Kept dependency-free
// so the mobile client can mirror it.

import type { RuntimeInstallKind, RuntimeRestartKind } from './runtime-types'

// Only unversioned artifact names are stable at the `latest/download` path;
// versioned deb/rpm filenames must come from release metadata, never invented.
const LATEST_DOWNLOAD_BASE = 'https://github.com/stablyai/orca/releases/latest/download'
// Same generic feed the desktop updater publishes electron-updater manifests to;
// the release-metadata lookup fetches `latest-*.yml` and resolves asset URLs
// against this base, so both share one source of truth for the origin.
export const ORCA_LATEST_DOWNLOAD_BASE_URL = LATEST_DOWNLOAD_BASE
export const ORCA_RELEASES_PAGE_URL = 'https://github.com/stablyai/orca/releases'
export const ORCA_HEADLESS_DOC_URL =
  'https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md'
export const ORCA_REPO_README_URL = 'https://github.com/stablyai/orca/blob/main/README.md'
export const ORCA_WINDOWS_SETUP_URL = `${LATEST_DOWNLOAD_BASE}/orca-windows-setup.exe`
export const MAC_HOMEBREW_UPGRADE_COMMAND =
  'brew update && brew upgrade --cask stablyai/orca/orca --greedy'

// Documented defaults, matching docs/reference/headless-linux-server.md. The
// path/service defaults live with the validation module (the trust boundary
// that falls back to them) so the two shared modules cannot drift.
export { DEFAULT_INSTALL_PATH, DEFAULT_SERVICE_NAME } from './runtime-update-info-validation'
export const DEFAULT_SERVE_PORT = 6768

export const APT_INSTALL_COMMAND = 'sudo apt install'
export const DNF_INSTALL_COMMAND = 'sudo dnf install'

const APPIMAGE_ASSET_X64 = 'orca-linux.AppImage'
const APPIMAGE_ASSET_ARM64 = 'orca-linux-arm64.AppImage'

export type RuntimeUpdateGuideArch = 'x64' | 'arm64'

const INSTALL_KIND_LABELS: Record<RuntimeInstallKind, string | null> = {
  'linux-appimage': 'Linux AppImage',
  'linux-deb': 'Debian/Ubuntu package',
  'linux-rpm': 'RPM package',
  'mac-app': 'macOS app',
  'mac-homebrew': 'macOS app',
  'windows-installer': 'Windows installer',
  source: 'source build',
  unknown: null
}

const RESTART_KIND_LABELS: Record<RuntimeRestartKind, string | null> = {
  systemd: 'systemd service',
  'foreground-serve': 'foreground orca serve',
  desktop: 'desktop app',
  unknown: null
}

// Comma-joins only the fields that resolved to a human label; null when neither
// install nor restart shape is known.
export function buildDetectedLine(
  installKind: RuntimeInstallKind | undefined,
  restartKind: RuntimeRestartKind | undefined
): string | null {
  const parts: string[] = []
  const installLabel = installKind ? INSTALL_KIND_LABELS[installKind] : null
  if (installLabel) {
    parts.push(installLabel)
  }
  const restartLabel = restartKind ? RESTART_KIND_LABELS[restartKind] : null
  if (restartLabel) {
    parts.push(restartLabel)
  }
  if (parts.length === 0) {
    return null
  }
  return `Detected: ${parts.join(', ')}.`
}

export function appImageAssetName(arch: RuntimeUpdateGuideArch | undefined): string {
  return arch === 'arm64' ? APPIMAGE_ASSET_ARM64 : APPIMAGE_ASSET_X64
}

// Sibling temp file + atomic same-dir `mv`: overwriting a running binary in
// place fails with ETXTBSY, so download to `<path>.new` then rename.
export function buildAppImageSwapCommand(
  installPath: string,
  arch: RuntimeUpdateGuideArch | undefined
): string {
  const asset = appImageAssetName(arch)
  return [
    `sudo curl -fL ${LATEST_DOWNLOAD_BASE}/${asset} \\`,
    `  -o ${installPath}.new`,
    `sudo chmod +x ${installPath}.new`,
    `sudo mv ${installPath}.new ${installPath}`
  ].join('\n')
}

export function buildSystemdRestartCommand(serviceName: string): string {
  return `sudo systemctl restart ${serviceName}`
}

// Only rendered when release metadata supplies the exact asset URL, so the
// versioned package filename is downloaded rather than guessed.
export function buildPackageDownloadAndInstallCommand(
  assetUrl: string,
  installCommand: string
): string {
  return `curl -fLO ${assetUrl}\n${installCommand} ./${assetFileName(assetUrl)}`
}

function assetFileName(assetUrl: string): string {
  const withoutQuery = assetUrl.split(/[?#]/)[0]
  const segments = withoutQuery.split('/')
  return segments.at(-1) || withoutQuery
}
