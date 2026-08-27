import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the spawn chokepoint at the tree level rather than per call site.
 *
 * Six decisions have to be made every time Orca starts a child process, and
 * Windows punishes each of them differently. Made per-call-site they were right
 * in some files and wrong in others. `run-process.ts` makes them once; this
 * test is what stops the 174th file from making them again.
 *
 * The allowlist only shrinks. A new direct import fails here even if it happens
 * to be correct today, because "correct today" is exactly what the wrong files
 * also were before someone copied them.
 */
/** The ratchet, held as data so it reads as the list it is. */
const CHILD_PROCESS_IMPORT_ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'child-process-import-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

const IMPORT_PATTERN =
  /(?:from\s+['"]node:child_process['"]|from\s+['"]child_process['"]|require\(\s*['"]node:child_process['"]|require\(\s*['"]child_process['"])/

const OWNER_DIRECTORY = 'src/shared/child-process'
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

/**
 * Tests may spawn freely: they are not shipped, and several exist precisely to
 * drive a raw child process against the wrapper's behaviour.
 */
function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|repro)/.test(path) ||
    path.includes('/__tests__/')
  )
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

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('child_process import boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..')
  const files = collectSourceFiles(join(repoRoot, 'src'))
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))
    .filter((path) => !path.startsWith(OWNER_DIRECTORY))
    .filter((path) => IMPORT_PATTERN.test(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('has no direct importer outside the allowlist', () => {
    const unlisted = offenders.filter((path) => !CHILD_PROCESS_IMPORT_ALLOWLIST.includes(path))
    expect(
      unlisted,
      'New direct child_process import. Use runProcess/spawnProcess from src/shared/child-process instead.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    // Why this direction matters too: a migrated file that stays listed hides
    // the next regression in the same path.
    const stale = CHILD_PROCESS_IMPORT_ALLOWLIST.filter((path) => !offenders.includes(path))
    expect(stale, 'Allowlist entry no longer imports child_process — delete the line.').toEqual([])
  })

  it('never grows', () => {
    // The count is asserted separately from membership so a swap (one file
    // migrated, one added) still fails loudly.
    expect(offenders.length).toBeLessThanOrEqual(CHILD_PROCESS_IMPORT_ALLOWLIST.length)
  })
})
