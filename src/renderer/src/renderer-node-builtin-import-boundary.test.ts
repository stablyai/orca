import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Walk the renderer's real module graph and fail on any Node builtin inside it.
 *
 * The renderer is sandboxed: no `process`, no `require`, and the bundler stubs `node:*` rather
 * than failing the build. So a shared module that spends `process.platform` or `promisify` at
 * import time does not break CI or packaging — it throws while the entry chunk evaluates, React
 * never mounts, and the app ships a white window. That is exactly how it shipped once: a renderer
 * poll-interval helper imported one constant from `shared/process-table-snapshot-reader`, which
 * pulled in `node:child_process`, `node:fs/promises`, `node:util`, and a top-level
 * `process.platform`.
 *
 * Seeded from the entry, not from every renderer file, because reachability is the whole property:
 * a `*.test-support.ts` file may import `node:path` freely as long as nothing shipped reaches it.
 */

const REPO_ROOT = resolve(__dirname, '../../..')
const RENDERER_ENTRY = join(REPO_ROOT, 'src/renderer/src/main.tsx')

/** Every specifier shape that creates a real edge, including bare `import './x'` — a
 *  side-effect import has no `from`, and is the exact shape that runs module-level code. */
const MODULE_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g
/** Type-only imports are erased before the bundle, so they never reach the sandbox. */
const TYPE_ONLY_IMPORT = /\bimport\s+type\b[\s\S]*?from\s+['"][^'"]+['"]/g
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g

/** Mirrors `renderer.resolve.alias` in electron.vite.config.ts. Most renderer imports are
 *  aliased, not relative, so a walker that only follows `./` sees a fraction of the graph. */
const ALIAS_PREFIXES: readonly [string, string][] = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]

function resolveImport(fromFile: string, specifier: string): string | null {
  const alias = ALIAS_PREFIXES.find(([prefix]) => specifier.startsWith(prefix))
  let base: string
  if (alias) {
    base = join(REPO_ROOT, alias[1], specifier.slice(alias[0].length))
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    return null
  }
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  )
}

function collectNodeBuiltinImporters(): { file: string; builtin: string; chain: string[] }[] {
  const parents = new Map<string, string>()
  const visited = new Set<string>([RENDERER_ENTRY])
  const queue = [RENDERER_ENTRY]
  const offenders: { file: string; builtin: string; chain: string[] }[] = []
  const reported = new Set<string>()

  const chainTo = (file: string): string[] => {
    const chain: string[] = []
    for (let cursor: string | undefined = file; cursor; cursor = parents.get(cursor)) {
      chain.push(relative(REPO_ROOT, cursor))
    }
    return chain.toReversed()
  }

  while (queue.length > 0) {
    const file = queue.shift()
    if (!file) {
      break
    }
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const runtimeSource = source.replaceAll(COMMENT, '').replaceAll(TYPE_ONLY_IMPORT, '')

    MODULE_SPECIFIER.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MODULE_SPECIFIER.exec(runtimeSource))) {
      const specifier = match[1]
      if (!specifier) {
        continue
      }
      if (specifier.startsWith('node:')) {
        // First builtin per file is enough to fail; the chain is what makes it fixable.
        if (!reported.has(file)) {
          reported.add(file)
          offenders.push({
            file: relative(REPO_ROOT, file),
            builtin: specifier,
            chain: chainTo(file)
          })
        }
        continue
      }
      const resolved = resolveImport(file, specifier)
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved)
        parents.set(resolved, file)
        queue.push(resolved)
      }
    }
  }

  return offenders
}

describe('renderer module graph', () => {
  it('reaches no Node builtin from the entry', () => {
    const offenders = collectNodeBuiltinImporters()
    const report = offenders
      .map((o) => `${o.file} imports ${o.builtin}\n  via ${o.chain.join('\n   -> ')}`)
      .join('\n\n')
    expect(report).toBe('')
  })
})
