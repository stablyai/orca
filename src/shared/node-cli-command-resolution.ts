import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

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
    // Why: GUI fallback probing should skip placeholders/directories so spawn
    // can continue to a runnable CLI instead of failing later with EACCES/EISDIR.
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
    join(homePath, '.fnm', 'aliases', 'default', 'bin'),
    // Why: mise (formerly rtx) exposes managed tool binaries via a shims
    // directory, similar to asdf.
    join(homePath, '.local', 'share', 'mise', 'shims')
  ]

  if (platform === 'win32') {
    // Why: Anthropic's native Windows installer places claude.exe here, and
    // GUI-launched Orca may not inherit the user's PATH entry for it.
    directories.push(join(homePath, '.local', 'bin'))
    directories.push(join(homePath, 'AppData', 'Roaming', 'npm'))
    directories.push(join(homePath, 'AppData', 'Local', 'pnpm'))
    directories.push(join(homePath, 'AppData', 'Local', 'Yarn', 'bin'))
  } else {
    directories.push(join(homePath, '.local', 'bin'))
    // Why: pnpm uses platform-specific global bin directories that differ from
    // npm's ~/.local/bin.
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

// Why bounded and cycle-guarded: an nvm alias may point at another alias
// (`default` -> `lts/*` -> `lts/krypton` -> a version), and a hand-edited pair
// can point at each other. nvm's own resolver tracks seen aliases; mirror that
// rather than trusting the files to be acyclic. Termination comes from the hop
// bound; the seen-set is what turns a cycle into "no preference" instead of
// silently resolving whichever alias the walk happened to stop on.
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
  // Why this is a cheap check and not the actual containment: join() normalizes
  // `..` away before we ever see it, so this only rejects the literal spelling.
  // The real guarantee is downstream — matchNvmVersion can only ever return an
  // entry of readdirSync(versions/node), so no token can put a foreign path on
  // PATH regardless of what the alias file says.
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
  // Why a full shape check: parseVersionSegment coerces every unparseable
  // segment to 0 (parseInt stops at the first non-digit), so an unresolvable
  // token prefix-matched `v0.12.x` — or any stray non-version directory —
  // instead of matching nothing. Anchoring only the first character was not
  // enough: `0x18`, `00` and `0abc` all still parsed to [0]. nvm writes such a
  // token to the alias file even while warning it does not exist, then answers
  // N/A for it, and so must we — which leaves newest-first ordering untouched.
  // Leading zeros are rejected for the same reason: nvm calls `00` and `024`
  // N/A, while parseInt happily reads them as 0 and 24.
  // (A length check cannot catch any of this: ''.split('.') is [''].)
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

  // Why default-first rather than newest-first: this ordering decides which node
  // a CLI runs under whenever the login-shell probe does not land. Newest is
  // usually the version the user just installed and has put nothing into, so it
  // hid every globally installed CLI and mismatched native module ABIs
  // (stablyai/orca#10932). The rest stay behind it as fallbacks, so a CLI
  // installed outside the default version is still reachable.
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
  const nvmCandidate = findFirstExecutable(
    platform,
    getNvmVersionDirectories(homePath),
    executableNames
  )
  const versionManagerCandidate =
    nvmCandidate ??
    findFirstExecutable(
      platform,
      getBaseVersionManagerDirectories(platform, homePath),
      executableNames
    )
  return versionManagerCandidate ?? commandName
}

export function resolveCliCommands(
  commandNames: readonly string[],
  options: ResolveCommandOptions = {}
): Map<string, string> {
  const platform = options.platform ?? process.platform
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? null
  const pathDirectories = splitPath(pathEnv)
  const homePath = options.homePath ?? homedir()
  const installDirectories = [
    ...getNvmVersionDirectories(homePath),
    ...getBaseVersionManagerDirectories(platform, homePath)
  ]
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

// Why: Win32 resolves env names case-insensitively and object order preserves
// the block order, so the entry the child will actually read is the FIRST
// case-insensitive match — not necessarily `Path` or `PATH`. Reading a narrower
// set than the dedupe below deletes would destroy a third spelling unread.
// Mirrors resolvePathEnvKey in src/main/pty/windows-path-segment-merge.ts, which
// src/shared must not import.
function firstWindowsPathEnvKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && env[key] !== undefined) {
      return key
    }
  }
  return 'Path'
}

/**
 * Put a resolved CLI's own directory ahead of PATH when that directory ships a
 * sibling `node`.
 *
 * Why: `resolveCliCommand` falls back to scanning every version-manager install
 * when PATH misses, so it can hand back `~/.nvm/versions/node/v20.x/bin/codex`
 * while PATH still leads with v22. The CLI's `#!/usr/bin/env node` shebang then
 * loads a v20-built native module under a v22 ABI and the agent dies on first
 * require (stablyai/orca#10932). Pair the binary with the runtime it was
 * installed against instead.
 *
 * Only prepends when the sibling `node` really exists, so a CLI resolved from a
 * directory that ships no node is left alone.
 */
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
  if (!findFirstExecutable(platform, [commandDirectory], getExecutableNames(platform, 'node'))) {
    return env
  }
  const pathKey = platform === 'win32' ? firstWindowsPathEnvKey(env) : 'PATH'
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  const segments = splitPath(env[pathKey], pathDelimiter)
  if (segments[0] === commandDirectory) {
    return env
  }
  const next = [commandDirectory, ...segments.filter((entry) => entry !== commandDirectory)].join(
    pathDelimiter
  )
  const paired = { ...env, [pathKey]: next }
  if (platform === 'win32') {
    // Why: the spread is case-sensitive while Windows env lookup is not, so a
    // differently-cased twin would keep shadowing the value we just wrote.
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
