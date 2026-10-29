import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { firstWindowsPathEnvKey, isNativeExecutable } from './cli-runtime-pairing-inputs'
import { getFnmDefaultAliasDirectories } from './fnm-default-alias-dirs'
import { getSystemCliInstallDirectories } from './system-cli-install-dirs'

type ResolveCommandOptions = {
  pathEnv?: string | null
  platform?: NodeJS.Platform
  homePath?: string
}

function getExecutableNames(platform: NodeJS.Platform, commandName: string): string[] {
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

function parseVersionSegment(raw: string): number[] {
  return raw
    .replace(/^v/i, '')
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((segment) => (Number.isFinite(segment) ? segment : 0))
}

function compareVersionDesc(left: string, right: string): number {
  const leftParts = parseVersionSegment(left)
  const rightParts = parseVersionSegment(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (delta !== 0) {
      return delta
    }
  }

  return right.localeCompare(left)
}

function findFirstExecutable(
  platform: NodeJS.Platform,
  directories: string[],
  executableNames: string[]
): string | null {
  for (const directory of directories) {
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName)
      if (isRunnableCommand(platform, candidate)) {
        return candidate
      }
    }
  }

  return null
}

function isRunnableCommand(platform: NodeJS.Platform, candidate: string): boolean {
  try {
    const stats = statSync(candidate)
    if (!stats.isFile()) {
      return false
    }
    if (platform === 'win32') {
      return true
    }
    // Skip nonexecutables/placeholders now so GUI probing reaches a runnable CLI instead of later EACCES/EISDIR.
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
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

// Bound/track nvm aliases (default → lts/* → lts/krypton → version). Hand-edited cycles must yield no preference,
// not whichever alias happens to exhaust the hop limit; mirror nvm’s seen-set behavior.
const NVM_ALIAS_CHAIN_LIMIT = 10

/** Resolves `alias/default` to an installed version directory name, or null. */
function resolveNvmDefaultVersion(nvmVersionsDir: string, installed: string[]): string | null {
  const aliasDir = join(nvmVersionsDir, '..', '..', 'alias')
  let token = readNvmAlias(join(aliasDir, 'default'))
  const seen = new Set<string>()
  for (let hop = 0; token && hop < NVM_ALIAS_CHAIN_LIMIT; hop += 1) {
    if (seen.has(token)) {
      return null
    }
    seen.add(token)
    const next = readNvmAlias(join(aliasDir, token))
    if (!next) {
      break
    }
    token = next
  }
  if (!token) {
    return null
  }
  // Why: `system` selects the OS node, so nvm owns nothing to prefer here.
  // `node`/`stable` mean newest, which is the ordering we already produce.
  if (token === 'system' || token === 'node' || token === 'stable') {
    return null
  }
  return matchNvmVersion(token, installed)
}

function readNvmAlias(aliasPath: string): string | null {
  // Reject literal traversal cheaply; join normalizes it away. Real containment comes from matchNvmVersion returning only installed readdir entries,
  // so arbitrary alias tokens can never add foreign paths to PATH.
  if (aliasPath.includes('..')) {
    return null
  }
  try {
    if (!statSync(aliasPath).isFile()) {
      return null
    }
    const value = readFileSync(aliasPath, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** `24` matches the highest installed `v24.x.y`; `v24.18.0` matches exactly. */
function matchNvmVersion(token: string, installed: string[]): string | null {
  // Validate full decimal version shape with no leading zeros: parseInt would coerce garbage/0x18/00/0abc to zero and select old v0.x.
  // nvm stores nonexistent aliases but resolves them as N/A; preserve newest-first fallback for those, including 024.
  if (!/^v?(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(token)) {
    return null
  }
  const wanted = parseVersionSegment(token)
  const matches = installed.filter((entry) => {
    const parts = parseVersionSegment(entry)
    return wanted.every((segment, index) => parts[index] === segment)
  })
  return matches.sort(compareVersionDesc)[0] ?? null
}

function getNvmVersionDirectories(homePath: string): string[] {
  const nvmVersionsDir = join(homePath, '.nvm', 'versions', 'node')
  if (!existsSync(nvmVersionsDir)) {
    return []
  }

  let installed: string[]
  try {
    installed = readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDesc)
  } catch {
    return []
  }

  // Prefer nvm default when login probing fails. Freshest installs often have no CLIs and mismatched native ABIs (#10932);
  // keep other installed versions as fallbacks so their CLIs remain reachable.
  const preferred = resolveNvmDefaultVersion(nvmVersionsDir, installed)
  const ordered = preferred
    ? [preferred, ...installed.filter((entry) => entry !== preferred)]
    : installed
  return ordered.map((entry) => join(nvmVersionsDir, entry, 'bin'))
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
function getCliInstallDirectories(platform: NodeJS.Platform, homePath: string): string[] {
  return [
    ...getNvmVersionDirectories(homePath),
    ...getBaseVersionManagerDirectories(platform, homePath),
    ...getSystemCliInstallDirectories(platform, homePath)
  ]
}

export function resolveCliCommand(
  commandName: string,
  options: ResolveCommandOptions = {}
): string {
  const platform = options.platform ?? process.platform
  const executableNames = getExecutableNames(platform, commandName)
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? null
  const pathCandidate = findFirstExecutable(platform, splitPath(pathEnv), executableNames)
  if (pathCandidate) {
    return pathCandidate
  }

  const homePath = options.homePath ?? homedir()
  const installCandidate = findFirstExecutable(
    platform,
    getCliInstallDirectories(platform, homePath),
    executableNames
  )
  return installCandidate ?? commandName
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
    const pathCandidate = findFirstExecutable(platform, pathDirectories, executableNames)
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
