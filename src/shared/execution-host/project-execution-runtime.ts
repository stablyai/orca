import type { ProjectGitRuntime } from './project-runtime-preference'
import {
  normalizeProjectRuntimePreference,
  normalizeGlobalWindowsRuntimeDefault,
  isKnownMissingDistro
} from './project-runtime-preference'
import type { LegacyWindowsRuntimeMigrationContext } from './project-runtime-legacy-migration'

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
      git?: ProjectGitRuntime
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

export type ResolveProjectExecutionRuntimeArgs = {
  appPlatform: string
  projectId: string
  projectRuntimePreference?: unknown
  globalWindowsRuntimeDefault?: unknown
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

type RuntimeSource = 'project-override' | 'global-default'

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
    return resolveWslRuntime(
      args,
      projectPreference.distro,
      'project-override',
      projectPreference.git
    )
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
  source: RuntimeSource,
  git?: ProjectGitRuntime
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
      ...(git ? { git } : {}),
      cacheKey: `${args.projectId}:wsl:${resolvedDistro}${git ? `:git-${git}` : ''}`
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
