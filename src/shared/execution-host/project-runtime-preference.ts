import { parseWslUncPath } from '../wsl-paths'

/**
 * `git: 'windows-host'` keeps terminals and agents in WSL but runs Orca's own Git on Windows: for a
 * project on a Windows drive, WSL Git is ~300x slower and misses Windows-side edits.
 */
export type ProjectGitRuntime = 'windows-host'

export type LocalWindowsRuntimePreference =
  | { kind: 'inherit-global' }
  | { kind: 'windows-host' }
  | { kind: 'wsl'; distro: string; git?: ProjectGitRuntime }

export type GlobalWindowsRuntimeDefault =
  | { kind: 'windows-host' }
  | { kind: 'wsl'; distro: string | null }

export function normalizeProjectRuntimePreference(value: unknown): LocalWindowsRuntimePreference {
  if (!isRecord(value)) {
    return { kind: 'inherit-global' }
  }

  if (value.kind === 'inherit-global') {
    return { kind: 'inherit-global' }
  }

  if (value.kind === 'windows-host') {
    return { kind: 'windows-host' }
  }

  if (value.kind === 'wsl') {
    const distro = normalizeDistro(value.distro)
    if (!distro) {
      return { kind: 'inherit-global' }
    }
    return value.git === 'windows-host'
      ? { kind: 'wsl', distro, git: 'windows-host' }
      : { kind: 'wsl', distro }
  }

  return { kind: 'inherit-global' }
}

/** A project with no saved runtime runs a workspace that lives in a WSL share inside that distro. */
export function getWorkspaceRuntimePreference(
  projectPreference: LocalWindowsRuntimePreference | undefined,
  workspacePath: string | null | undefined
): LocalWindowsRuntimePreference {
  if (projectPreference) {
    return projectPreference
  }
  const distro = workspacePath ? parseWslUncPath(workspacePath)?.distro : undefined
  return distro ? { kind: 'wsl', distro } : { kind: 'inherit-global' }
}

export function normalizeGlobalWindowsRuntimeDefault(value: unknown): GlobalWindowsRuntimeDefault {
  if (!isRecord(value)) {
    return { kind: 'windows-host' }
  }

  if (value.kind === 'wsl') {
    return { kind: 'wsl', distro: normalizeDistro(value.distro) }
  }

  return { kind: 'windows-host' }
}

export function isKnownMissingDistro(
  distro: string,
  availableWslDistros: readonly string[] | null | undefined
): boolean {
  return Array.isArray(availableWslDistros) && !availableWslDistros.includes(distro)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeDistro(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
