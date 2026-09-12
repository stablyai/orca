export type PackageManagerName = 'pnpm' | 'bun' | 'yarn' | 'npm'

export type PackageJsonScript = {
  /** Script key as declared under `scripts` in package.json. */
  name: string
  /** The shell command the script runs. Shown only as a tooltip/subtitle. */
  command: string
}

// Why: mirrors the lockfile→manager table used by setup-script package-manager
// suggestion so run-command detection stays consistent with install detection.
const LOCKFILE_TO_MANAGER: Record<string, PackageManagerName> = {
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm'
}

const PACKAGE_MANAGER_PREFIXES: PackageManagerName[] = ['pnpm', 'bun', 'yarn', 'npm']

function parsePackageJson(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(content)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Extract the `scripts` block from raw package.json content, preserving the
 * declared order. Returns an empty array when the file is missing, unparseable,
 * or has no (string-valued) scripts.
 */
export function parsePackageJsonScripts(content: string | null): PackageJsonScript[] {
  const packageJson = parsePackageJson(content)
  const scripts = packageJson?.scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return []
  }
  const result: PackageJsonScript[] = []
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command === 'string' && name.trim().length > 0) {
      result.push({ name, command })
    }
  }
  return result
}

/**
 * Resolve the package manager from a package.json `packageManager` field value
 * (e.g. `"pnpm@9.1.0"`). Returns null when absent or unrecognized.
 */
export function detectPackageManagerFromField(value: unknown): PackageManagerName | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toLowerCase()
  return PACKAGE_MANAGER_PREFIXES.find((manager) => normalized.startsWith(`${manager}@`)) ?? null
}

/**
 * Resolve the package manager from lockfiles present in a worktree root. Returns
 * null when no lockfile is found or multiple conflicting managers are detected.
 */
export function detectPackageManagerFromLockfiles(
  fileNames: readonly string[]
): PackageManagerName | null {
  const managers = new Set<PackageManagerName>()
  for (const fileName of fileNames) {
    const manager = LOCKFILE_TO_MANAGER[fileName]
    if (manager) {
      managers.add(manager)
    }
  }
  return managers.size === 1 ? [...managers][0] : null
}

/**
 * Resolve the effective package manager for running scripts: the explicit
 * `packageManager` field wins, then lockfile detection, then npm as the
 * universal fallback.
 */
export function resolvePackageManager(
  packageManagerField: unknown,
  lockfileNames: readonly string[]
): PackageManagerName {
  return (
    detectPackageManagerFromField(packageManagerField) ??
    detectPackageManagerFromLockfiles(lockfileNames) ??
    'npm'
  )
}

/**
 * Build the terminal command that runs a package.json script with the given
 * manager. `<pm> run <name>` is valid for all four managers (npm requires it,
 * pnpm/yarn/bun accept it), so a uniform form avoids conflicts with built-in
 * subcommands (e.g. `bun test`, `yarn install`).
 */
export function buildPackageManagerRunCommand(
  manager: PackageManagerName,
  scriptName: string
): string {
  return `${manager} run ${scriptName}`
}

export function getPackageJsonField(content: string | null, field: string): unknown {
  return parsePackageJson(content)?.[field]
}
