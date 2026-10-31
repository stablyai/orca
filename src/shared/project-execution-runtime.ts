import { parseWslUncPath } from './wsl-paths'
import type {
  LocalWindowsRuntimePreference,
  GlobalWindowsRuntimeDefault,
  ProjectExecutionRuntimeResolution,
  ProjectExecutionRuntimeRepairReason,
  LegacyWindowsRuntimeSettings,
  LegacyWindowsRuntimeMigrationContext,
  LegacyWindowsRuntimeFallbackReason,
  LegacyWindowsRuntimeDefaultMigration,
  ResolveProjectExecutionRuntimeArgs,
  NormalizedProjectExecutionRuntimeInput
} from './project-execution-runtime-types'
export type {
  ProjectGitRuntime,
  LocalWindowsRuntimePreference,
  GlobalWindowsRuntimeDefault,
  ProjectExecutionRuntimeReason,
  ResolvedProjectExecutionRuntime,
  ProjectExecutionRuntimeRepairReason,
  ProjectExecutionRuntimeRepair,
  ProjectExecutionRuntimeResolution,
  LegacyWindowsRuntimeSettings,
  LegacyWindowsRuntimeMigrationContext,
  LegacyWindowsRuntimeFallbackReason,
  LegacyWindowsRuntimeDefaultMigration,
  ResolveProjectExecutionRuntimeArgs,
  NormalizedProjectExecutionRuntimeInput
} from './project-execution-runtime-types'

export function normalizeProjectExecutionRuntimeInput(
  args: ResolveProjectExecutionRuntimeArgs
): NormalizedProjectExecutionRuntimeInput {
  if (args.appPlatform !== 'win32') {
    return { kind: 'local-host', appPlatform: args.appPlatform, projectId: args.projectId }
  }
  const preference = normalizeProjectRuntimePreference(args.projectRuntimePreference)
  if (preference.kind === 'windows-host') {
    return { kind: 'windows-host', projectId: args.projectId, source: 'project-override' }
  }
  const fallback =
    preference.kind === 'inherit-global'
      ? normalizeGlobalWindowsRuntimeDefault(args.globalWindowsRuntimeDefault)
      : undefined
  const selected = preference.kind === 'wsl' ? preference : fallback
  if (selected?.kind !== 'wsl') {
    return { kind: 'windows-host', projectId: args.projectId, source: 'global-default' }
  }
  const distro = selected.distro
  return {
    kind: 'wsl',
    projectId: args.projectId,
    source: preference.kind === 'wsl' ? 'project-override' : 'global-default',
    distro,
    git: preference.kind === 'wsl' ? preference.git : undefined,
    wslAvailable: distro ? args.wslAvailable : undefined,
    selectedDistroAvailable:
      distro && Array.isArray(args.availableWslDistros)
        ? args.availableWslDistros.includes(distro)
        : undefined
  }
}

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

export function resolveProjectExecutionRuntime(
  args: ResolveProjectExecutionRuntimeArgs
): ProjectExecutionRuntimeResolution {
  return materializeProjectExecutionRuntime(normalizeProjectExecutionRuntimeInput(args))
}

function materializeProjectExecutionRuntime(
  input: NormalizedProjectExecutionRuntimeInput
): ProjectExecutionRuntimeResolution {
  if (input.kind === 'local-host') {
    return {
      status: 'resolved',
      runtime: {
        kind: 'local-host',
        hostPlatform: input.appPlatform,
        projectId: input.projectId,
        reason: 'non-windows',
        cacheKey: `${input.projectId}:local-host:${input.appPlatform}`
      }
    }
  }
  return input.kind === 'windows-host'
    ? resolvedWindowsHost(input.projectId, input.source)
    : resolveWslRuntime(input)
}

function resolveWslRuntime(
  input: Extract<NormalizedProjectExecutionRuntimeInput, { kind: 'wsl' }>
): ProjectExecutionRuntimeResolution {
  const { projectId, distro, source, git } = input
  if (!distro) {
    return {
      status: 'repair-required',
      repair: {
        projectId,
        preferredRuntime: { kind: 'wsl', distro },
        reason: 'wsl-distro-required',
        source,
        cacheKey: `${projectId}:repair:wsl-distro-required:default`
      }
    }
  }

  const repairReason = getWslRepairReason(input)
  if (repairReason) {
    return {
      status: 'repair-required',
      repair: {
        projectId,
        preferredRuntime: { kind: 'wsl', distro },
        reason: repairReason,
        source,
        cacheKey: `${projectId}:repair:${repairReason}:${distro ?? 'default'}`
      }
    }
  }

  const resolvedDistro = distro
  return {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId,
      distro: resolvedDistro,
      reason: source,
      ...(git ? { git } : {}),
      cacheKey: `${projectId}:wsl:${resolvedDistro}${git ? `:git-${git}` : ''}`
    }
  }
}

function resolvedWindowsHost(
  projectId: string,
  reason: 'project-override' | 'global-default' | 'migration-fallback'
): ProjectExecutionRuntimeResolution {
  return {
    status: 'resolved',
    runtime: {
      kind: 'windows-host',
      hostPlatform: 'win32',
      projectId,
      reason,
      cacheKey: `${projectId}:windows-host`
    }
  }
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

function getWslRepairReason(
  input: Extract<NormalizedProjectExecutionRuntimeInput, { kind: 'wsl' }>
): ProjectExecutionRuntimeRepairReason | null {
  if (input.wslAvailable === false) {
    return 'wsl-unavailable'
  }
  if (input.selectedDistroAvailable === false) {
    return 'wsl-distro-missing'
  }
  return null
}

function isKnownMissingDistro(
  distro: string,
  availableWslDistros: readonly string[] | null | undefined
): boolean {
  return Array.isArray(availableWslDistros) && !availableWslDistros.includes(distro)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeDistro(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function isWslShell(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const shellName = value.trim().split(/[\\/]/).pop()?.toLowerCase()
  return shellName === 'wsl.exe' || shellName === 'wsl'
}
