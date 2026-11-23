import { join } from 'node:path'
import { runCliFsReadsSync, type CliFsReads } from './cli-fs-reads'

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

// Bound/track nvm aliases (default → lts/* → lts/krypton → version). Hand-edited cycles must yield no preference,
// not whichever alias happens to exhaust the hop limit; mirror nvm’s seen-set behavior.
const NVM_ALIAS_CHAIN_LIMIT = 10

/** Resolves `alias/default` to an installed version directory name, or null. */
function* resolveNvmDefaultVersion(
  nvmVersionsDir: string,
  installed: string[]
): CliFsReads<string | null> {
  const aliasDir = join(nvmVersionsDir, '..', '..', 'alias')
  let token = yield* readNvmAlias(join(aliasDir, 'default'))
  const seen = new Set<string>()
  for (let hop = 0; token && hop < NVM_ALIAS_CHAIN_LIMIT; hop += 1) {
    if (seen.has(token)) {
      return null
    }
    seen.add(token)
    const next = yield* readNvmAlias(join(aliasDir, token))
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

function* readNvmAlias(aliasPath: string): CliFsReads<string | null> {
  // Reject literal traversal cheaply; join normalizes it away. Real containment comes from matchNvmVersion returning only installed readdir entries,
  // so arbitrary alias tokens can never add foreign paths to PATH.
  if (aliasPath.includes('..')) {
    return null
  }
  const contents = yield { kind: 'file', path: aliasPath }
  const value = typeof contents === 'string' ? contents.trim() : ''
  return value.length > 0 ? value : null
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

/** nvm's bin dirs, default alias first; yields its reads so async callers stay off the event loop. */
export function* nvmVersionDirectories(homePath: string): CliFsReads<string[]> {
  const nvmVersionsDir = join(homePath, '.nvm', 'versions', 'node')
  const entries = yield { kind: 'dirs', path: nvmVersionsDir }
  if (!Array.isArray(entries)) {
    return []
  }
  const installed = entries.sort(compareVersionDesc)

  // Prefer nvm default when login probing fails. Freshest installs often have no CLIs and mismatched native ABIs (#10932);
  // keep other installed versions as fallbacks so their CLIs remain reachable.
  const preferred = yield* resolveNvmDefaultVersion(nvmVersionsDir, installed)
  const ordered = preferred
    ? [preferred, ...installed.filter((entry) => entry !== preferred)]
    : installed
  return ordered.map((entry) => join(nvmVersionsDir, entry, 'bin'))
}

export function getNvmVersionDirectories(homePath: string): string[] {
  return runCliFsReadsSync(nvmVersionDirectories(homePath))
}
