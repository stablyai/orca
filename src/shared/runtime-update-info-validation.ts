import type { RuntimeInstallKind, RuntimeRestartKind, RuntimeUpdateInfo } from './runtime-types'

// Why: every field of updateInfo crosses a trust boundary — it comes from a
// possibly-compromised server and some of it is rendered into commands the user
// pastes into a root shell. This module discards anything that fails validation
// and substitutes documented defaults, so the advisor UI can trust its output.
// Dependency-free (no Electron/Node imports; `new URL` exists everywhere) so the
// mobile client can mirror it.

// Why: the template `sudo systemctl restart`s / `sudo mv`s onto these, so a
// rejected server value must fall back to a value the client itself owns.
export const DEFAULT_SERVICE_NAME = 'orca-serve.service'
export const DEFAULT_INSTALL_PATH = '/opt/orca/orca-linux.AppImage'

const INSTALL_KINDS: ReadonlySet<RuntimeInstallKind> = new Set([
  'mac-app',
  'mac-homebrew',
  'windows-installer',
  'linux-appimage',
  'linux-deb',
  'linux-rpm',
  'source',
  'unknown'
])

const RESTART_KINDS: ReadonlySet<RuntimeRestartKind> = new Set([
  'desktop',
  'foreground-serve',
  'systemd',
  'unknown'
])

const RECOGNIZED_ARCHES = ['x64', 'arm64'] as const
type RecognizedArch = (typeof RECOGNIZED_ARCHES)[number]

// Mandatory `orca` prefix: mirrors the systemd cgroup-detection trust rule so a
// compromised server cannot aim the restart at `sshd.service`; the leading
// alphanumeric also means the value can never parse as a `systemctl` flag.
const SERVICE_NAME_PATTERN = /^orca[A-Za-z0-9@:._-]{0,75}\.service$/
// Absolute, no spaces/quotes/shell metacharacters. The `.AppImage` suffix is
// load-bearing: the template `sudo mv`s onto this path.
const INSTALL_PATH_PATTERN = /^[A-Za-z0-9/._~+-]{1,256}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]{1,40})?$/

// Why: without the `m` flag, `$` also matches just before a trailing newline, so
// `"orca-serve.service\n"` would pass a `…\.service$` test and smuggle a newline
// into a command. Reject any string carrying a line break outright.
const matchesFully = (value: string, pattern: RegExp): boolean =>
  !/[\r\n]/.test(value) && pattern.test(value)

const validateServiceName = (value: unknown): string | undefined =>
  typeof value === 'string' && matchesFully(value, SERVICE_NAME_PATTERN) ? value : undefined

const validateInstallPath = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  value.endsWith('.AppImage') &&
  // Reject `..` outright: the char class permits it, but a traversal segment
  // could steer the template's `sudo mv` above the intended install dir even
  // while keeping the load-bearing `.AppImage` suffix.
  !value.includes('..') &&
  matchesFully(value, INSTALL_PATH_PATTERN)
    ? value
    : undefined

const validateVersion = (value: unknown): string | undefined =>
  typeof value === 'string' && matchesFully(value, VERSION_PATTERN) ? value : undefined

// Render only when the origin is github.com and the *parsed* pathname is exactly
// `/stablyai/orca` or a child of it. Parsing defeats `…/orca/../other-repo`
// (which a raw prefix check passes); the trailing slash rules out `orca-foo`.
const validateDocsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.origin !== 'https://github.com') {
    return undefined
  }
  const path = parsed.pathname
  if (path === '/stablyai/orca' || path.startsWith('/stablyai/orca/')) {
    return value
  }
  return undefined
}

const validateInstallKind = (value: unknown): RuntimeInstallKind =>
  typeof value === 'string' && INSTALL_KINDS.has(value as RuntimeInstallKind)
    ? (value as RuntimeInstallKind)
    : 'unknown'

const validateRestartKind = (value: unknown): RuntimeRestartKind =>
  typeof value === 'string' && RESTART_KINDS.has(value as RuntimeRestartKind)
    ? (value as RuntimeRestartKind)
    : 'unknown'

const validateHostArch = (value: unknown): RecognizedArch | undefined =>
  RECOGNIZED_ARCHES.includes(value as RecognizedArch) ? (value as RecognizedArch) : undefined

/**
 * The advisor-trusted shape derived from untrusted server `updateInfo`.
 *
 * `serviceName`, `installPath`, `installKind`, and `restartKind` are always
 * present — a rejected server value falls back to a documented default (or
 * `'unknown'`), because the guide templates need something safe to render.
 * Display-only fields are optional: absent means "the server gave us nothing
 * valid to show", not "use a default".
 */
export type ValidatedRuntimeUpdateInfo = {
  serviceName: string
  installPath: string
  installKind: RuntimeInstallKind
  restartKind: RuntimeRestartKind
  currentVersion?: string
  latestVersion?: string
  updateAvailable?: boolean
  hostArch?: RecognizedArch
  docsUrl?: string
}

/**
 * Validate untrusted server-supplied `updateInfo`. Never throws: a wholly
 * absent input (cold-start servers send none) or non-string garbage in any
 * field yields the defaults shape with display-only fields omitted.
 */
export const validateRuntimeUpdateInfo = (
  updateInfo: RuntimeUpdateInfo | null | undefined
): ValidatedRuntimeUpdateInfo => {
  const info = (updateInfo ?? {}) as Record<keyof RuntimeUpdateInfo, unknown>

  const validated: ValidatedRuntimeUpdateInfo = {
    serviceName: validateServiceName(info.serviceName) ?? DEFAULT_SERVICE_NAME,
    installPath: validateInstallPath(info.installPath) ?? DEFAULT_INSTALL_PATH,
    installKind: validateInstallKind(info.installKind),
    restartKind: validateRestartKind(info.restartKind)
  }

  const currentVersion = validateVersion(info.currentVersion)
  if (currentVersion !== undefined) {
    validated.currentVersion = currentVersion
  }

  const latestVersion = validateVersion(info.latestVersion)
  if (latestVersion !== undefined) {
    validated.latestVersion = latestVersion
  }

  // Only a literal boolean passes; null/undefined/garbage → absent.
  if (typeof info.updateAvailable === 'boolean') {
    validated.updateAvailable = info.updateAvailable
  }

  const hostArch = validateHostArch(info.hostArch)
  if (hostArch !== undefined) {
    validated.hostArch = hostArch
  }

  const docsUrl = validateDocsUrl(info.docsUrl)
  if (docsUrl !== undefined) {
    validated.docsUrl = docsUrl
  }

  return validated
}
