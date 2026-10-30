import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { firstWindowsPathEnvKey, isNativeExecutable } from './cli-runtime-pairing-inputs'
import { getFnmDefaultAliasDirectories } from './fnm-default-alias-dirs'
import { getNvmVersionDirectories, nvmVersionDirectories } from './nvm-version-directories'
import { isRunnableCommand, runCliFsReadsSync, type CliFsReads } from './cli-fs-reads'
import { getSystemCliInstallDirectories } from './system-cli-install-dirs'

export type ResolveCommandOptions = {
  pathEnv?: string | null
  platform?: NodeJS.Platform
  homePath?: string
  /** Skip the PATH scan; the caller already established absence there (agent detection batches it). */
  skipPathSearch?: boolean
}

export function getExecutableNames(platform: NodeJS.Platform, commandName: string): string[] {
  if (platform === 'win32') {
    return [`${commandName}.cmd`, `${commandName}.exe`, `${commandName}.bat`, commandName]
  }

  return [commandName]
}

function splitPath(
  pathEnv: string | null | undefined,
  pathDelimiter: string = delimiter
): string[] {
  if (!pathEnv) {
    return []
  }

  return pathEnv
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function* firstRunnable(
  platform: NodeJS.Platform,
  directories: string[],
  executableNames: string[]
): CliFsReads<string | null> {
  for (const directory of directories) {
    for (const executableName of executableNames) {
      const path = join(directory, executableName)
      if ((yield { kind: 'runnable', platform, path }) === true) {
        return path
      }
    }
  }
  return null
}

function findFirstExecutable(
  platform: NodeJS.Platform,
  directories: string[],
  executableNames: string[]
): string | null {
  return runCliFsReadsSync(firstRunnable(platform, directories, executableNames))
}

function getBaseVersionManagerDirectories(platform: NodeJS.Platform, homePath: string): string[] {
  const directories = [
    join(homePath, '.volta', 'bin'),
    join(homePath, '.asdf', 'shims'),
    ...getFnmDefaultAliasDirectories(platform, homePath),
    join(homePath, '.local', 'share', 'mise', 'shims')
  ]

  if (platform === 'win32') {
    // Native Windows Claude installs here; GUI launches may lack the user PATH entry.
    directories.push(join(homePath, '.local', 'bin'))
    directories.push(join(homePath, 'AppData', 'Roaming', 'npm'))
    directories.push(join(homePath, 'AppData', 'Local', 'pnpm'))
    directories.push(join(homePath, 'AppData', 'Local', 'Yarn', 'bin'))
  } else {
    directories.push(join(homePath, '.local', 'bin'))
    // pnpm global bins vary by platform, unlike npm’s ~/.local/bin.
    if (platform === 'darwin') {
      directories.push(join(homePath, 'Library', 'pnpm'))
    } else {
      directories.push(join(homePath, '.local', 'share', 'pnpm'))
    }
    directories.push(join(homePath, '.yarn', 'bin'))
  }

  directories.push(join(homePath, '.bun', 'bin'))
  return directories
}

function getVersionManagerDirectories(
  platform: NodeJS.Platform,
  homePath: string,
  executableNames: string[]
): string[] {
  const directories = getBaseVersionManagerDirectories(platform, homePath)
  const firstNvmMatch = findFirstExecutable(
    platform,
    getNvmVersionDirectories(homePath),
    executableNames
  )
  if (firstNvmMatch) {
    directories.unshift(dirname(firstNvmMatch))
  }
  return directories
}

// Share native/WSL ordering: version-manager bins must precede system Homebrew/npm/snap installs.
function* cliInstallDirectories(platform: NodeJS.Platform, homePath: string): CliFsReads<string[]> {
  return [
    ...(yield* nvmVersionDirectories(homePath)),
    ...getBaseVersionManagerDirectories(platform, homePath),
    ...getSystemCliInstallDirectories(platform, homePath)
  ]
}

function getCliInstallDirectories(platform: NodeJS.Platform, homePath: string): string[] {
  return runCliFsReadsSync(cliInstallDirectories(platform, homePath))
}

/** PATH entries first; install dirs are listed only once PATH misses. Run with cli-fs-reads. */
export function* cliCommandLookup(
  commandName: string,
  options: ResolveCommandOptions = {}
): CliFsReads<string> {
  const platform = options.platform ?? process.platform
  const names = getExecutableNames(platform, commandName)
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? null
  return (
    (yield* firstRunnable(platform, splitPath(pathEnv), names)) ??
    (yield* firstRunnable(
      platform,
      yield* cliInstallDirectories(platform, options.homePath ?? homedir()),
      names
    )) ??
    commandName
  )
}

export function resolveCliCommand(
  commandName: string,
  options: ResolveCommandOptions = {}
): string {
  return runCliFsReadsSync(cliCommandLookup(commandName, options))
}

/** Resolve a literal override without falling back to an unverified command name. */
export function resolveExecutableCommand(
  command: string,
  options: ResolveCommandOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  const expanded =
    command.startsWith('~/') || command.startsWith('~\\')
      ? join(options.homePath ?? homedir(), command.slice(2))
      : command
  if (isAbsolute(expanded)) {
    return isRunnableCommand(platform, expanded) ? expanded : null
  }
  // Relative paths depend on the workspace, which a session-less catalog cannot name.
  if (expanded.includes('/') || expanded.includes('\\')) {
    return null
  }
  const resolved = resolveCliCommand(expanded, options)
  return isAbsolute(resolved) && isRunnableCommand(platform, resolved) ? resolved : null
}

export function resolveCliCommands(
  commandNames: readonly string[],
  options: ResolveCommandOptions = {}
): Map<string, string> {
  const platform = options.platform ?? process.platform
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? null
  const pathDirectories = splitPath(pathEnv)
  const homePath = options.homePath ?? homedir()
  const installDirectories = getCliInstallDirectories(platform, homePath)
  const resolved = new Map<string, string>()

  for (const commandName of new Set(commandNames)) {
    const executableNames = getExecutableNames(platform, commandName)
    const pathCandidate = options.skipPathSearch
      ? undefined
      : findFirstExecutable(platform, pathDirectories, executableNames)
    const installCandidate =
      pathCandidate ?? findFirstExecutable(platform, installDirectories, executableNames)
    resolved.set(commandName, installCandidate ?? commandName)
  }

  return resolved
}

export function resolveCodexCommand(options: ResolveCommandOptions = {}): string {
  return resolveCliCommand('codex', options)
}

export function resolveClaudeCommand(options: ResolveCommandOptions = {}): string {
  return resolveCliCommand('claude', options)
}

/** Pair resolved script CLIs with sibling Node on PATH to preserve their installed native-module ABI (#10932).
 * Fallback discovery can find a v20 CLI while PATH leads with v22; env-node shebangs would crash on require.
 * Prepend only if sibling Node exists and the CLI is not a compiled binary. */
export function withCliRuntimeOnPath<T extends NodeJS.ProcessEnv>(
  commandPath: string,
  env: T,
  options: Pick<ResolveCommandOptions, 'platform'> = {}
): T {
  const platform = options.platform ?? process.platform
  if (!isAbsolute(commandPath)) {
    return env
  }
  const commandDirectory = dirname(commandPath)
  if (
    !findFirstExecutable(platform, [commandDirectory], getExecutableNames(platform, 'node')) ||
    isNativeExecutable(commandPath)
  ) {
    return env
  }
  const pathKey = platform === 'win32' ? firstWindowsPathEnvKey(env) : 'PATH'
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  // Missing child PATH inherits Orca’s; pair over that inherited value.
  const segments = splitPath(env[pathKey] ?? process.env[pathKey], pathDelimiter)
  if (segments[0] === commandDirectory) {
    return env
  }
  const next = [commandDirectory, ...segments.filter((entry) => entry !== commandDirectory)].join(
    pathDelimiter
  )
  const paired = { ...env, [pathKey]: next }
  if (platform === 'win32') {
    // Windows environment keys ignore case but object spreads do not; remove alternate-case twins that could shadow the new PATH.
    for (const name of Object.keys(paired)) {
      if (name !== pathKey && name.toLowerCase() === pathKey.toLowerCase()) {
        delete (paired as NodeJS.ProcessEnv)[name]
      }
    }
  }
  return paired as T
}

// Why: Node-script CLIs need their version-manager sibling `node` on PATH.
export function getVersionManagerBinPaths(options: ResolveCommandOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const homePath = options.homePath ?? homedir()
  const nodeNames = getExecutableNames(platform, 'node')
  return getVersionManagerDirectories(platform, homePath, nodeNames)
}
