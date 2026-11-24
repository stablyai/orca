import type { GlobalWindowsRuntimeDefault } from './project-runtime-preference'
import { normalizeDistro, isKnownMissingDistro } from './project-runtime-preference'

export type LegacyWindowsRuntimeSettings = {
  localAgentRuntime?: unknown
  localAgentWslDistro?: unknown
  terminalWindowsShell?: unknown
  terminalWindowsWslDistro?: unknown
}

export type LegacyWindowsRuntimeMigrationContext = {
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

export type LegacyWindowsRuntimeFallbackReason =
  | 'legacy-wsl-unavailable'
  | 'legacy-wsl-distro-missing'

export type LegacyWindowsRuntimeDefaultMigration = {
  defaultRuntime: GlobalWindowsRuntimeDefault
  fallbackReason: LegacyWindowsRuntimeFallbackReason | null
}

export function deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
  settings: LegacyWindowsRuntimeSettings | null | undefined,
  context: LegacyWindowsRuntimeMigrationContext = {}
): LegacyWindowsRuntimeDefaultMigration {
  const selectedRuntime = settings?.localAgentRuntime
  if (selectedRuntime === 'host') {
    return { defaultRuntime: { kind: 'windows-host' }, fallbackReason: null }
  }

  if (selectedRuntime === 'wsl' || isWslShell(settings?.terminalWindowsShell)) {
    const distro =
      normalizeDistro(settings?.localAgentWslDistro) ??
      normalizeDistro(settings?.terminalWindowsWslDistro)
    const fallbackReason = getLegacyWslFallbackReason(distro, context)
    if (fallbackReason) {
      return { defaultRuntime: { kind: 'windows-host' }, fallbackReason }
    }
    return { defaultRuntime: { kind: 'wsl', distro }, fallbackReason: null }
  }

  return { defaultRuntime: { kind: 'windows-host' }, fallbackReason: null }
}

function getLegacyWslFallbackReason(
  distro: string | null,
  context: LegacyWindowsRuntimeMigrationContext
): LegacyWindowsRuntimeFallbackReason | null {
  if (context.wslAvailable === false) {
    return 'legacy-wsl-unavailable'
  }
  if (distro && isKnownMissingDistro(distro, context.availableWslDistros)) {
    return 'legacy-wsl-distro-missing'
  }
  return null
}

function isWslShell(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const shellName = value.trim().split(/[\\/]/).pop()?.toLowerCase()
  return shellName === 'wsl.exe' || shellName === 'wsl'
}
