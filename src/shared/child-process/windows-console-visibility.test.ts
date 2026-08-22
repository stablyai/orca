import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every direct child-process call must pass `windowsHide`.
 *
 * Without it a GUI Electron process that spawns a console subsystem binary gets
 * a real console window: it flashes, and it steals foreground. On a git status
 * poll that is once per poll (#10488). `run-process.ts` sets the flag for
 * everything routed through it; this guards the calls that still spawn directly.
 *
 * The flag is inert off Windows, so this asks for it unconditionally rather than
 * making each site reason about its platform.
 *
 * The allowlist only shrinks — it is also the migration worklist. Removing a
 * file from it means either adding the flag or, better, routing the call
 * through the chokepoint.
 */
const ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'windows-console-visibility-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

const CHILD_PROCESS_IMPORT =
  /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]/
const SPAWN_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])
const SOURCE_ROOT = resolve(__dirname, '../..')

/**
 * Blank out comments before scanning.
 *
 * Why: `runner.ts` documents its wrapper as `execFileSync('git', args, {...})`
 * in a doc comment. Counted as a call it can never be satisfied, so the file
 * would sit on the allowlist forever and a genuine regression in it would be
 * pre-approved -- a ratchet that only looks like one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|repro)/.test(path) ||
    path.includes('/__tests__/')
  )
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found.push(...collectSourceFiles(path))
      continue
    }
    if (/\.tsx?$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

/** The call's argument text, brace-matched so a nested options literal stays whole. */
function readCallArguments(source: string, openParenIndex: number): string {
  let depth = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1
    } else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return source.slice(openParenIndex, index)
      }
    }
  }
  return source.slice(openParenIndex)
}

function findOffenders(): string[] {
  const offenders = new Set<string>()
  for (const path of collectSourceFiles(SOURCE_ROOT)) {
    const relativePath = relative(SOURCE_ROOT, path).replace(/\\/g, '/')
    if (isTestFile(relativePath)) {
      continue
    }
    const source = stripComments(readFileSync(path, 'utf8'))
    if (!CHILD_PROCESS_IMPORT.test(source)) {
      continue
    }
    for (const match of source.matchAll(SPAWN_CALL)) {
      if (!readCallArguments(source, match.index + match[0].length - 1).includes('windowsHide')) {
        offenders.add(relativePath)
      }
    }
  }
  return [...offenders].sort()
}

describe('direct child-process calls hide the Windows console', () => {
  const offenders = findOffenders()

  it('scans a realistic number of files', () => {
    // Guards against an import-pattern change quietly emptying the scan, which
    // would make every assertion below pass without checking anything.
    expect(offenders.length + ALLOWLIST.length).toBeGreaterThan(50)
  })

  it('adds no new file that spawns without windowsHide', () => {
    expect(offenders.filter((path) => !ALLOWLIST.includes(path))).toEqual([])
  })

  it('carries no stale allowlist entry', () => {
    // A fixed file must leave the list, or the ratchet stops ratcheting.
    expect(ALLOWLIST.filter((path) => !offenders.includes(path))).toEqual([])
  })
})
