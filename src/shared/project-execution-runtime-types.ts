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

export type NormalizedProjectExecutionRuntimeInput =
  | { kind: 'local-host'; appPlatform: string; projectId: string }
  | { kind: 'windows-host'; projectId: string; source: RuntimeSource }
  | {
      kind: 'wsl'
      projectId: string
      source: RuntimeSource
      distro: string | null
      git: ProjectGitRuntime | undefined
      wslAvailable: boolean | undefined
      selectedDistroAvailable: boolean | undefined
    }
