export type LocalWindowsRuntimePreference =
  | { kind: 'inherit-global' }
  | { kind: 'windows-host' }
  | { kind: 'wsl'; distro: string }

export type GlobalWindowsRuntimeDefault =
  | { kind: 'windows-host' }
  | { kind: 'wsl'; distro: string | null }

export type ProjectExecutionRuntimeReason =
  | 'project-override'
  | 'global-default'
  | 'migration-fallback'
  | 'non-windows'

export type ResolvedProjectExecutionRuntime =
  | {
      kind: 'local-host'
      hostPlatform: string
      projectId: string
      reason: 'non-windows'
      cacheKey: string
    }
  | {
      kind: 'windows-host'
      hostPlatform: 'win32'
      projectId: string
      reason: Exclude<ProjectExecutionRuntimeReason, 'non-windows'>
      cacheKey: string
    }
  | {
      kind: 'wsl'
      hostPlatform: 'wsl'
      projectId: string
      distro: string
      reason: 'project-override' | 'global-default'
      cacheKey: string
    }

export type ProjectExecutionRuntimeRepairReason =
  | 'wsl-unavailable'
  | 'wsl-distro-required'
  | 'wsl-distro-missing'

export type ProjectExecutionRuntimeRepair = {
  projectId: string
  preferredRuntime: { kind: 'wsl'; distro: string | null }
  reason: ProjectExecutionRuntimeRepairReason
  source: 'project-override' | 'global-default'
  cacheKey: string
}

export type ProjectExecutionRuntimeResolution =
  | { status: 'resolved'; runtime: ResolvedProjectExecutionRuntime }
  | { status: 'repair-required'; repair: ProjectExecutionRuntimeRepair }

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

export type ResolveProjectExecutionRuntimeArgs = {
  appPlatform: string
  projectId: string
  projectRuntimePreference?: unknown
  globalWindowsRuntimeDefault?: unknown
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

type RuntimeSource = 'project-override' | 'global-default'

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
    return distro ? { kind: 'wsl', distro } : { kind: 'inherit-global' }
  }

  return { kind: 'inherit-global' }
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
  if (args.appPlatform !== 'win32') {
    return {
      status: 'resolved',
      runtime: {
        kind: 'local-host',
        hostPlatform: args.appPlatform,
        projectId: args.projectId,
        reason: 'non-windows',
        cacheKey: `${args.projectId}:local-host:${args.appPlatform}`
      }
    }
  }

  const projectPreference = normalizeProjectRuntimePreference(args.projectRuntimePreference)
  if (projectPreference.kind === 'windows-host') {
    return resolvedWindowsHost(args.projectId, 'project-override')
  }

  if (projectPreference.kind === 'wsl') {
    return resolveWslRuntime(args, projectPreference.distro, 'project-override')
  }

  const globalDefault = normalizeGlobalWindowsRuntimeDefault(args.globalWindowsRuntimeDefault)
  if (globalDefault.kind === 'wsl') {
    return resolveWslRuntime(args, globalDefault.distro, 'global-default')
  }

  return resolvedWindowsHost(args.projectId, 'global-default')
}

function resolveWslRuntime(
  args: ResolveProjectExecutionRuntimeArgs,
  distro: string | null,
  source: RuntimeSource
): ProjectExecutionRuntimeResolution {
  if (!distro) {
    return {
      status: 'repair-required',
      repair: {
        projectId: args.projectId,
        preferredRuntime: { kind: 'wsl', distro },
        reason: 'wsl-distro-required',
        source,
        cacheKey: `${args.projectId}:repair:wsl-distro-required:default`
      }
    }
  }

  const repairReason = getWslRepairReason(distro, {
    wslAvailable: args.wslAvailable,
    availableWslDistros: args.availableWslDistros
  })
  if (repairReason) {
    return {
      status: 'repair-required',
      repair: {
        projectId: args.projectId,
        preferredRuntime: { kind: 'wsl', distro },
        reason: repairReason,
        source,
        cacheKey: `${args.projectId}:repair:${repairReason}:${distro ?? 'default'}`
      }
    }
  }

  const resolvedDistro = distro
  return {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId: args.projectId,
      distro: resolvedDistro,
      reason: source,
      cacheKey: `${args.projectId}:wsl:${resolvedDistro}`
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
  distro: string,
  context: LegacyWindowsRuntimeMigrationContext
): ProjectExecutionRuntimeRepairReason | null {
  if (context.wslAvailable === false) {
    return 'wsl-unavailable'
  }
  if (isKnownMissingDistro(distro, context.availableWslDistros)) {
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
