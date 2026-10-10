import { compareAppVersions, isValidAppVersion, parseCliVersion } from './app-version'

export const CODEX_MINIMUM_SUPPORTED_VERSION = '0.136.0'

export type CodexCliInstallation = {
  status: 'missing' | 'unsupported' | 'ready' | 'unknown'
  version: string | null
  minimumVersion: string
}

export type CodexInstallationProblem = {
  installedVersion: string | null
  minimumVersion: string
}

export function parseCodexCliVersion(output: string | null | undefined): string | null {
  const lines = output?.split(/\r?\n/).map((line) => line.trim()) ?? []
  const identified = lines.filter((line) => /^codex(?:-cli)?\s/i.test(line))
  const candidates = identified.length ? identified : lines.filter(Boolean)
  const versions = candidates.map((line) => {
    const value = line.replace(/^codex(?:-cli)?\s+/i, '').replace(/^v/i, '')
    return isValidAppVersion(value) ? parseCliVersion(value) : null
  })
  return versions.length && versions.every((version) => version !== null && version === versions[0])
    ? versions[0]
    : null
}

export function codexCliInstallation(
  installed: boolean,
  output: string | null
): CodexCliInstallation {
  const version = parseCodexCliVersion(output)
  return {
    status: !installed
      ? 'missing'
      : version === null
        ? 'unknown'
        : compareAppVersions(version, CODEX_MINIMUM_SUPPORTED_VERSION) < 0
          ? 'unsupported'
          : 'ready',
    version,
    minimumVersion: CODEX_MINIMUM_SUPPORTED_VERSION
  }
}

export function readCodexInstallationProblem(value: unknown): CodexInstallationProblem | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('installedVersion' in value) ||
    !('minimumVersion' in value) ||
    (value.installedVersion !== null &&
      (typeof value.installedVersion !== 'string' || !isValidAppVersion(value.installedVersion))) ||
    typeof value.minimumVersion !== 'string' ||
    !isValidAppVersion(value.minimumVersion)
  ) {
    return undefined
  }
  return { installedVersion: value.installedVersion, minimumVersion: value.minimumVersion }
}
