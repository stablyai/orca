import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the CLI/runtime pairing at the tree level rather than per call site.
 *
 * `resolveCliCommand` falls back to scanning every version-manager install, so
 * it can return a CLI from one Node version while PATH leads with another. The
 * CLI's `#!/usr/bin/env node` shebang then picks the wrong runtime and a native
 * module dies on NODE_MODULE_VERSION (stablyai/orca#10932). Six call sites got
 * this wrong at once because each made the decision separately.
 *
 * Pairing is one call — `withCliRuntimeOnPath` — and this test is what stops the
 * next spawn site from forgetting it.
 */
const ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'cli-runtime-pairing-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

// Why no call-paren: several sites pass the resolver as a value into a
// dependency bag (`resolveCommand: resolveCodexCommand`) and call it later, so
// requiring `(` here let exactly that shape through the ratchet unnoticed.
const RESOLVES_CLI = /\b(?:resolveCliCommand|resolveCodexCommand|resolveClaudeCommand)\b/
// Why the exec/fork family too: a resolved CLI handed to execFile is the same
// unpaired launch as spawn. The first draft matched only the spawn names, and
// codex-trust-grant-host.ts — which resolves a CLI and calls execFileSync — was
// invisible to the ratchet purely through that omission.
// The lookbehind keeps `RE.exec(` and other method calls out.
const SPAWNS =
  /(?<!\.)\b(?:spawn|spawnProcess|spawnSync|runProcess|execFile|execFileSync|execSync|exec|fork)\s*\(/
const PAIRS = /\bwithCliRuntimeOnPath\b/

const SCANNED_ROOTS = ['src/main', 'src/shared', 'src/cli']
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
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found = found.concat(collectSourceFiles(path))
    } else if (/\.tsx?$/.test(path) && !isTestFile(path)) {
      found.push(path)
    }
  }
  return found
}

describe('CLI runtime pairing boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..')

  function offenders(): string[] {
    return SCANNED_ROOTS.flatMap((scanRoot) => collectSourceFiles(join(repoRoot, scanRoot)))
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return RESOLVES_CLI.test(source) && SPAWNS.test(source) && !PAIRS.test(source)
      })
      .map((path) => relative(repoRoot, path).split('\\').join('/'))
      .sort()
  }

  it('pairs every resolved CLI with its own node runtime', () => {
    expect(offenders()).toEqual([...ALLOWLIST].sort())
  })

  it('keeps the allowlist honest — every entry still resolves and spawns a CLI', () => {
    const stale = ALLOWLIST.filter((entry) => {
      let source: string
      try {
        source = readFileSync(join(repoRoot, entry), 'utf8')
      } catch {
        return true
      }
      return !(RESOLVES_CLI.test(source) && SPAWNS.test(source)) || PAIRS.test(source)
    })
    // Why: an entry that no longer needs the exemption must be deleted, not left
    // to quietly re-authorize a future edit to the same file.
    expect(stale).toEqual([])
  })
})
