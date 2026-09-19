import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The renderer runs sandboxed with contextIsolation: `node:*` builtins do not resolve and even a
 * bare `process` read throws. A module that reaches one is not a degraded feature — the chunk
 * fails at evaluation, React never mounts, and the window stays blank with `workspaceSessionReady`
 * stuck false (#18742 did exactly this by importing one constant out of a `node:child_process`
 * module). Bundling hides it: the offending module can sit in a shared chunk far from the import
 * that pulled it in.
 *
 * So walk the import graph from every renderer entry — lazy routes included, since a `node:`
 * builtin behind one is just a blank route instead of a blank app — and refuse any builtin.
 */
const RENDERER_SRC = import.meta.dirname
const REPO_SRC = path.resolve(RENDERER_SRC, '../..')
const ENTRIES = ['main.tsx', 'popout.tsx', 'web/main.tsx']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

/** `import`/`export ... from` and `import(...)` specifiers, minus type-only ones, which erase. */
function collectValueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const pattern =
    /(?:^|[\s;}])(?:import|export)(\s+type\s|\s*\{[^}]*\}|[^'"]*?)?\s*from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? ''
    const specifier = match[2] ?? match[3] ?? match[4]
    if (!specifier || /^\s*type\s/.test(clause)) {
      continue
    }
    // A brace clause whose every binding is `type`-prefixed also erases entirely.
    const bindings = clause.trim().startsWith('{') ? clause.trim().slice(1, -1).split(',') : null
    if (bindings && bindings.some((b) => b.trim()) && bindings.every((b) => /^\s*type\s/.test(b))) {
      continue
    }
    specifiers.push(specifier)
  }
  return specifiers
}

function resolveModule(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith('@renderer/')) {
    base = path.join(RENDERER_SRC, specifier.slice('@renderer/'.length))
  } else if (specifier.startsWith('@/')) {
    base = path.join(RENDERER_SRC, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier)
  } else {
    // Bare package specifiers are npm dependencies, not first-party source.
    return null
  }
  for (const candidate of [
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))
  ]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function walkRendererImportGraph(): Map<string, string[]> {
  /** file -> the chain of first-party importers that reached it, entry first. */
  const pathToFile = new Map<string, string[]>()
  const queue: string[] = []
  for (const entry of ENTRIES) {
    const file = path.join(RENDERER_SRC, entry)
    pathToFile.set(file, [file])
    queue.push(file)
  }
  while (queue.length > 0) {
    const file = queue.shift() as string
    const chain = pathToFile.get(file) as string[]
    for (const specifier of collectValueImportSpecifiers(readFileSync(file, 'utf8'))) {
      const resolved = resolveModule(specifier, file)
      if (!resolved || pathToFile.has(resolved)) {
        continue
      }
      pathToFile.set(resolved, [...chain, resolved])
      queue.push(resolved)
    }
  }
  return pathToFile
}

describe('renderer node-builtin boundary', () => {
  it('reaches no module that imports a node: builtin', () => {
    const graph = walkRendererImportGraph()
    const offenders: string[] = []
    for (const [file, chain] of graph) {
      const builtins = collectValueImportSpecifiers(readFileSync(file, 'utf8')).filter(
        (specifier) => specifier.startsWith('node:')
      )
      if (builtins.length === 0) {
        continue
      }
      const relativeChain = chain.map((step) => path.relative(REPO_SRC, step)).join('\n    -> ')
      offenders.push(`${builtins.join(', ')} via\n    ${relativeChain}`)
    }
    expect(offenders.join('\n\n')).toBe('')
  })

  it('walks a real graph, so an empty offender list means something', () => {
    const graph = walkRendererImportGraph()
    expect(graph.size).toBeGreaterThan(3_000)
    expect(graph.has(path.join(REPO_SRC, 'shared/process-table-snapshot.ts'))).toBe(true)
  })
})
