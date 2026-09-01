import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

/**
 * Guard the base-resolution chokepoint at the tree level rather than per call site.
 *
 * `TuiAgent` unions built-in ids with custom ones, so `tab.launchAgent === 'codex'`
 * type-checks and is silently false for every Codex agent a user derived. That is
 * how the Codex account-switch restart prompt came to skip custom agents: the same
 * field was base-resolved in one file and compared raw in the next one over.
 *
 * What this can and cannot see: it matches the field compared directly, a local
 * that keeps the field's name, and a local assigned FROM the field under any name.
 * It cannot follow a value through a function boundary or a reshaped object — the
 * `BuiltInTuiAgent` parameter types are what close those. This is defense in
 * depth, so read a pass as "no new instance of the known shape", not as proof.
 *
 * Entries are `path:count` and the counts only shrink. A new raw comparison fails
 * here even when it happens to be right today, because "right today" is what the
 * drifted sites also were before someone copied them.
 */
type AllowlistEntry = { path: string; count: number }

const ALLOWLIST: readonly AllowlistEntry[] = readFileSync(
  join(__dirname, '__fixtures__', 'raw-agent-identity-comparison-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((line) => {
    const separator = line.lastIndexOf(':')
    return { path: line.slice(0, separator), count: Number(line.slice(separator + 1)) }
  })

/** Fields that carry the REQUESTED identity, which may be a custom agent id. */
const REQUESTED_IDENTITY_FIELDS = [
  'launchAgent',
  'createdWithAgent',
  'startupAgent',
  'requestedAgent',
  'quickAgent',
  'defaultTuiAgent'
] as const

/** An alias initialized from one of these is already base-resolved. */
const BASE_RESOLVERS = [
  'classifyAgentBaseIdentity',
  'resolveAgentBaseIdentity',
  'resolvePaneOwnerBaseAgent',
  'resolveTuiAgentBaseAgent',
  'resolveTuiAgentConfig'
] as const

/** Read from the config so a newly added built-in is covered without edits here. */
const BUILT_IN_IDS = Object.keys(TUI_AGENT_CONFIG)

const FIELD_GROUP = REQUESTED_IDENTITY_FIELDS.join('|')
const ID_GROUP = BUILT_IN_IDS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const RESOLVER_GROUP = BASE_RESOLVERS.join('|')

// Both operand orders. A resolver call between the field and the operator
// (`classifyAgentBaseIdentity(tab.launchAgent) === 'codex'`) is not a match, which
// is exactly the shape this ratchet is steering call sites toward.
const DIRECT_COMPARISON = new RegExp(
  `(?:\\.|\\b)(?:${FIELD_GROUP})\\??\\s*(?:===|!==)\\s*['"](?:${ID_GROUP})['"]` +
    `|['"](?:${ID_GROUP})['"]\\s*(?:===|!==)\\s*[\\w.?]*\\b(?:${FIELD_GROUP})\\b`,
  'g'
)
/** `const x = <something carrying a requested field>` — x inherits the hazard. */
const ALIAS_BINDING = new RegExp(
  `(?:const|let|var)\\s+(\\w+)\\s*(?::[^=]+)?=\\s*([^=\\n;]*\\b(?:${FIELD_GROUP})\\b[^\\n;]*)`,
  'g'
)

const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/** Blank comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n')
}

/** Locals that took a requested field's value without resolving it first. */
function unresolvedAliases(code: string): string[] {
  const aliases = new Set<string>()
  for (const match of code.matchAll(ALIAS_BINDING)) {
    const [, name, initializer] = match
    // A name that says "base", or an initializer that ran a resolver, is settled.
    if (/[Bb]ase/.test(name as string) || new RegExp(RESOLVER_GROUP).test(initializer as string)) {
      continue
    }
    aliases.add(name as string)
  }
  return [...aliases]
}

function countRawComparisons(code: string): number {
  let count = [...code.matchAll(DIRECT_COMPARISON)].length
  for (const alias of unresolvedAliases(code)) {
    const aliasComparison = new RegExp(
      `\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*(?:===|!==)\\s*['"](?:${ID_GROUP})['"]`,
      'g'
    )
    count += [...code.matchAll(aliasComparison)].length
  }
  return count
}

describe('requested-agent comparison boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..', '..')
  const files = collectSourceFiles(join(repoRoot, 'src'))
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))
    .map((path) => ({
      path,
      count: countRawComparisons(codeText(readFileSync(join(repoRoot, path), 'utf8')))
    }))
    .filter((entry) => entry.count > 0)

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('recognizes every built-in id', () => {
    // A renamed config export would empty the id group and match nothing.
    expect(BUILT_IN_IDS).toContain('codex')
    expect(BUILT_IN_IDS).toContain('claude')
  })

  it('has no raw comparison in an unlisted file', () => {
    const listed = new Set(ALLOWLIST.map((entry) => entry.path))
    const unlisted = offenders.filter((entry) => !listed.has(entry.path)).map((entry) => entry.path)
    expect(
      unlisted,
      'A requested-agent field is compared against a built-in id, so custom agents derived from ' +
        'that base will not match. Resolve through classifyAgentBaseIdentity / ' +
        'resolveAgentBaseIdentity in src/renderer/src/lib/agent-base-identity.ts first.'
    ).toEqual([])
  })

  it('has no file that grew past its allowed count', () => {
    // Why per-file counts rather than a bare path list: pty.ts and orca-runtime.ts
    // are thousands of lines, and exempting them wholesale would let the next raw
    // comparison land in exactly the files that hold the most of them.
    const byPath = new Map(offenders.map((entry) => [entry.path, entry.count]))
    const grown = ALLOWLIST.filter((entry) => (byPath.get(entry.path) ?? 0) > entry.count).map(
      (entry) => `${entry.path}: ${byPath.get(entry.path)} > ${entry.count}`
    )
    expect(grown, 'New raw comparison in an allowlisted file — resolve the base instead.').toEqual(
      []
    )
  })

  it('has no stale or over-stated allowlist entry', () => {
    // A count left too high hides the next regression behind slack, and a file
    // that no longer compares raw must leave the list entirely.
    const byPath = new Map(offenders.map((entry) => [entry.path, entry.count]))
    const stale = ALLOWLIST.filter((entry) => (byPath.get(entry.path) ?? 0) !== entry.count).map(
      (entry) => `${entry.path}: allowed ${entry.count}, actual ${byPath.get(entry.path) ?? 0}`
    )
    expect(stale, 'Allowlist count no longer matches — lower it to the real number.').toEqual([])
  })
})
