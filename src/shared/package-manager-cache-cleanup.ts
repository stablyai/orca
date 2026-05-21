import type {
  WorkspacePackageManager,
  WorkspacePackageManagerCacheCleanupAction,
  WorkspacePackageManagerCacheCleanupSafety
} from './workspace-space-types'

type PackageManagerCacheDefinition = {
  packageManager: WorkspacePackageManager
  lockfiles: readonly string[]
  actions: readonly Omit<WorkspacePackageManagerCacheCleanupAction, 'packageManager' | 'command'>[]
}

const DEFINITIONS: readonly PackageManagerCacheDefinition[] = [
  {
    packageManager: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    actions: [
      {
        id: 'pnpm-store-prune',
        safety: 'safe',
        binary: 'pnpm',
        args: ['store', 'prune'],
        label: 'Prune pnpm store',
        description:
          'Removes unreferenced packages from the pnpm store without editing projects or lockfiles.'
      }
    ]
  },
  {
    packageManager: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    actions: [
      {
        id: 'npm-cache-verify',
        safety: 'safe',
        binary: 'npm',
        args: ['cache', 'verify'],
        label: 'Verify npm cache',
        description: 'Verifies cache integrity and garbage-collects unneeded npm cache data.'
      },
      {
        id: 'npm-cache-clean-force',
        safety: 'aggressive',
        binary: 'npm',
        args: ['cache', 'clean', '--force'],
        label: 'Clean npm cache',
        description: 'Deletes npm cache data. Future installs may need to download packages again.'
      }
    ]
  },
  {
    packageManager: 'yarn',
    lockfiles: ['yarn.lock'],
    actions: [
      {
        id: 'yarn-cache-clean',
        safety: 'aggressive',
        binary: 'yarn',
        args: ['cache', 'clean'],
        label: 'Clean Yarn cache',
        description:
          'Removes Yarn shared cache files. Future installs may need to download packages again.'
      }
    ]
  },
  {
    packageManager: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    actions: [
      {
        id: 'bun-pm-cache-rm',
        safety: 'aggressive',
        binary: 'bun',
        args: ['pm', 'cache', 'rm'],
        label: 'Clean Bun cache',
        description:
          'Removes Bun global module cache data. Future installs may need to download packages again.'
      }
    ]
  }
]

const DEFINITIONS_BY_MANAGER = new Map(
  DEFINITIONS.map((definition) => [definition.packageManager, definition])
)

export function formatPackageManagerCacheCommand(binary: string, args: readonly string[]): string {
  return [binary, ...args].join(' ')
}

export function createPackageManagerCacheTargetId(
  connectionId: string | null,
  packageManager: WorkspacePackageManager,
  cwd: string
): string {
  return `${connectionId ? `ssh:${encodeURIComponent(connectionId)}` : 'local'}:${packageManager}:${encodeURIComponent(cwd)}`
}

export function getPackageManagerLabel(packageManager: WorkspacePackageManager): string {
  switch (packageManager) {
    case 'npm':
      return 'npm'
    case 'pnpm':
      return 'pnpm'
    case 'yarn':
      return 'Yarn'
    case 'bun':
      return 'Bun'
  }
}

export function getPackageManagerCacheCleanupActions(
  packageManager: WorkspacePackageManager
): WorkspacePackageManagerCacheCleanupAction[] {
  const definition = DEFINITIONS_BY_MANAGER.get(packageManager)
  if (!definition) {
    return []
  }
  return definition.actions.map((action) => ({
    ...action,
    packageManager,
    command: formatPackageManagerCacheCommand(action.binary, action.args)
  }))
}

export function getPackageManagerCacheCleanupAction(
  packageManager: WorkspacePackageManager,
  actionId: string
): WorkspacePackageManagerCacheCleanupAction | null {
  return (
    getPackageManagerCacheCleanupActions(packageManager).find((action) => action.id === actionId) ??
    null
  )
}

export function getPackageManagerCacheSafetyCopy(
  safety: WorkspacePackageManagerCacheCleanupSafety
): string {
  switch (safety) {
    case 'safe':
      return 'Safe default'
    case 'aggressive':
      return 'Aggressive'
  }
}

export function detectPackageManagersFromFilenames(
  filenames: readonly string[]
): Map<WorkspacePackageManager, string[]> {
  const names = new Set(filenames)
  const detected = new Map<WorkspacePackageManager, string[]>()
  for (const definition of DEFINITIONS) {
    const lockfiles = definition.lockfiles.filter((lockfile) => names.has(lockfile))
    if (lockfiles.length > 0) {
      detected.set(definition.packageManager, lockfiles)
    }
  }
  return detected
}
