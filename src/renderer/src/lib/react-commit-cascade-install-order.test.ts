import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * react-dom reads __REACT_DEVTOOLS_GLOBAL_HOOK__ once, at its own module
 * evaluation, and enters the graph through several component modules rather
 * than just the entry's import of react-renderer-root. ES evaluation is
 * depth-first in source order, so only the FIRST import statement is guaranteed
 * to beat it — and only if that module's own graph cannot reach react-dom
 * first, which is why the shim has no imports at all.
 *
 * Nothing else fails when either property stops holding: the diagnostic simply
 * records nothing. These tests are the failure.
 */
const RENDERER_ROOT = resolve(__dirname, '..')
const SHIM_MODULE = 'react-devtools-commit-hook-shim'
const SHIM_IMPORT = `import './lib/${SHIM_MODULE}'`
const OBSERVER_IMPORT = "import './lib/react-commit-cascade-observer'"

/** Entries whose crash reports reach the breadcrumb pipe. */
const INSTRUMENTED_ENTRIES = ['main.tsx', 'popout.tsx']
/**
 * The web preload stubs crashReports.recordBreadcrumb to a no-op
 * (src/renderer/src/web/preload-api/web-diagnostics-api.ts), so instrumenting
 * the web entry would cost commits and record nothing.
 */
const UNINSTRUMENTED_ENTRIES = [join('web', 'main.tsx')]

function firstImportStatement(source: string): string | undefined {
  return source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('import '))
}

function importedSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s*'([^']+)'/g))
    .map((match) => match[1] as string)
    .concat(
      Array.from(source.matchAll(/(?:^|\n)\s*import\s*'([^']+)'/g)).map(
        (match) => match[1] as string
      )
    )
}

/** Mirrors the alias in config/vitest.config.ts and electron.vite.config.ts. */
function resolveLocalModule(specifier: string, fromFile: string): string | undefined {
  const base = specifier.startsWith('@/')
    ? join(RENDERER_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? join(dirname(fromFile), specifier)
      : undefined
  if (base === undefined) {
    return undefined
  }
  // Only TS: a .css or asset import cannot pull react-dom into the graph.
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) =>
    existsSync(candidate)
  )
}

/** Bare specifiers stay as-is; local ones are followed so a hop cannot hide react-dom. */
function transitiveSpecifiers(entryFile: string): Set<string> {
  const seen = new Set<string>()
  const specifiers = new Set<string>()
  const queue = [entryFile]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      specifiers.add(specifier)
      const local = resolveLocalModule(specifier, file)
      if (local) {
        queue.push(local)
      }
    }
  }
  return specifiers
}

describe('react commit cascade shim install order', () => {
  for (const entry of INSTRUMENTED_ENTRIES) {
    it(`keeps the import-free shim as the first import in ${entry}`, () => {
      const source = readFileSync(join(RENDERER_ROOT, entry), 'utf8')

      expect(source).toContain(SHIM_IMPORT)
      expect(firstImportStatement(source)).toBe(SHIM_IMPORT)
    })

    // Why separate: the observer wraps a property react-dom re-reads per commit,
    // so it only has to be in the graph, not first in it.
    it(`still installs the observer in ${entry}`, () => {
      expect(readFileSync(join(RENDERER_ROOT, entry), 'utf8')).toContain(OBSERVER_IMPORT)
    })
  }

  for (const entry of UNINSTRUMENTED_ENTRIES) {
    it(`leaves ${entry} uninstrumented, where breadcrumbs are a no-op`, () => {
      const source = readFileSync(join(RENDERER_ROOT, entry), 'utf8')

      expect(source).not.toContain('react-commit-cascade-observer')
    })
  }

  // Why this is the real ratchet: one import here that transitively reaches
  // react-dom would let react-dom evaluate first and read no hook, killing the
  // diagnostic in production with every other test still green.
  it('keeps the shim free of imports, react-dom above all', () => {
    const shimFile = join(RENDERER_ROOT, 'lib', `${SHIM_MODULE}.ts`)

    const graph = transitiveSpecifiers(shimFile)
    expect(Array.from(graph).filter((specifier) => specifier.includes('react-dom'))).toEqual([])
    expect(Array.from(graph)).toEqual([])
    // Why a source scan too: the specifier regex only sees an import whose `from`
    // shares a line with the keyword, and a multi-line import is the common form
    // here — so the graph check alone would miss the one edit that matters.
    // Why `from` must be followed by a quote: bare `\bfrom\b` also matched the
    // word in a comment, and a ratchet that fails on prose gets deleted.
    // Why the `import(` arm: a top-level `await import(...)` makes this module
    // async, so react-dom evaluates before the hook is installed.
    expect(readFileSync(shimFile, 'utf8')).not.toMatch(
      /^\s*(?:import|export)\b[\s\S]*?\bfrom\s*(?:\/\*[\s\S]*?\*\/\s*)*['"]|^\s*import\s*['"]|\bimport\s*\(/m
    )
  })

  it('follows local hops when checking a graph for react-dom', () => {
    const observerFile = join(RENDERER_ROOT, 'lib', 'react-commit-cascade-observer.ts')

    // The observer's own graph is allowed to be wide; this only proves the walker
    // above sees past the first hop, so an empty shim graph means something.
    expect(transitiveSpecifiers(observerFile).size).toBeGreaterThan(3)
  })
})
